import fs from 'fs';
import path from 'path';
import * as MRE from '@microsoft/mixed-reality-extension-sdk';
import { Vector2 } from '@microsoft/mixed-reality-extension-sdk';
import { CellData, GridMenu } from './GUI/gridMenu';
import { PinyinDatabase, levelData } from './database';
import { checkUserName, fetchJSON, getGltf, joinUrl, lineBreak } from './utils';
import { NumberInput } from './GUI/NumberInput';

const OWNER_NAME = process.env['OWNER_NAME'];
const THUMBNAILS_BASE_URL = "https://raw.githubusercontent.com/illuminati360/alt-hanzi-data/master/thumbnails/";
const MODELS_BASE_URL = "https://raw.githubusercontent.com/illuminati360/alt-hanzi-data/master/models/";

const HANZI_MODEL_SCALE = 0.0001*8;
const HANZI_MODEL_ROTATION = MRE.Quaternion.FromEulerAngles(0 * MRE.DegreesToRadians, 0 * MRE.DegreesToRadians, 0 * MRE.DegreesToRadians);

const SCALE_STEP = 0.025/1000;

const gltfBoundingBox = require('gltf-bounding-box');

type BoundingBoxDimensions = {
    dimensions: {
        width: number,
        height: number,
        depth: number
    },
    center: {
        x: number,
        y: number,
        z: number
    }
}

const PINYIN_INFO_PLACE_HOLDER = 'Awaiting Input';
const PINYIN_INFO_ERROR_MESSAGE = 'No Such Syllable';

/**
 * The main class of this app. All the logic goes here.
 */
export default class Hanzi {
    private context: MRE.Context;
    private assets: MRE.AssetContainer;
    private baseUrl: string;

    private root: MRE.Actor;
    private home: MRE.Actor;
    private textures: Map<string, MRE.Texture>;
    private materials: Map<string, MRE.Material>;
    private prefabs: Map<string, MRE.Prefab>;
    private dimensions: Map<string, BoundingBoxDimensions>;
    private highlightBoxes: Map<MRE.Actor, MRE.Actor>;
    private spawnedHanzi: Map<MRE.Actor, string>;

    private pinyinDatabase: PinyinDatabase;
    private characters: string[];
    private radicals: string[];

    private pinyinSound: MRE.Sound;
    private sprite: any;
    private boundingBoxMaterial: MRE.Material;
    private invisibleMaterial: MRE.Material;

    private pinyinInfoText: string = '';

    private highlightedActor: MRE.Actor;

    private radicalPageNum: number;
    private hanziPageNum: number;

    // scene
    private scenes: Array<[string, GridMenu[]]> = [];
    private currentScene: string = '';

    // main_menu scene
    private mainMenu: GridMenu;

    // pinyin_menu
    private pinyinMenu: GridMenu;
    private pinyinHead: GridMenu;
    private pinyinTone: GridMenu;
    private pinyinMenuControlStrip: GridMenu;
    private pinyinInfoPanel: GridMenu;

    // phonetics table
    private phoneticsTable: GridMenu;

    // commonly used
    private commonHanziMenu: GridMenu;
    private hanziInfoPanel: GridMenu;
    private commonHanziMenuControlStrip: GridMenu;
    private numberInput: NumberInput;

    // constructor
	constructor(private _context: MRE.Context, private params: MRE.ParameterSet, _baseUrl: string) {
        this.context = _context;
        this.baseUrl = _baseUrl;
        this.assets = new MRE.AssetContainer(this.context);

        this.boundingBoxMaterial = this.assets.createMaterial('bounding_box_material', { color: MRE.Color4.FromColor3(MRE.Color3.Red(), 0.4), alphaMode: MRE.AlphaMode.Blend} )
        this.invisibleMaterial = this.assets.createMaterial('bounding_box_material', { color: MRE.Color4.FromColor3(MRE.Color3.Red(), 0), alphaMode: MRE.AlphaMode.Blend} )

        this.textures = new Map<string, MRE.Texture>();
        this.materials = new Map<string, MRE.Material>();
        this.highlightBoxes = new Map<MRE.Actor, MRE.Actor>();
        this.spawnedHanzi = new Map<MRE.Actor, string>();

        this.prefabs = new Map<string, MRE.Prefab>();
        this.dimensions = new Map<string, BoundingBoxDimensions>();

        this.context.onStarted(() => this.init());
    }
    
    private init() {
        // data
        this.loadData();
        this.loadSounds();


        // root actor
        this.createRoot();
        // home button
        this.createHomeButton();

        // menus for main_menu scene
        this.createMainMenu();

        // menus for pinyin_menu scene
        this.createPinyinMenu();
        this.createPinyinHead();
        this.createPinyinTone();
        this.createPinyinMenuControlStrip();
        this.createPinyinInfoPanel();

        // menus for phonetics_table scene
        // this.createPhoneticsTable();
        this.createPhoneticsPanel();

        // menus for common_hanzi_menu scene
        this.createCommonHanziMenu();
        this.createHanziInfoPanel();
        this.createCommonHanziMenuControlStrip();
        this.createNumberInput();
        this.updateCommonHanziMenu( this.getCommonHanziPageData() );

        // scenes
        this.scenes.push(['main_menu', [this.mainMenu]]);
        this.scenes.push(['pinyin_menu', [this.pinyinMenu, this.pinyinMenuControlStrip, this.pinyinHead, this.pinyinTone, this.pinyinInfoPanel]]);
        this.scenes.push(['phonetics_table', [this.phoneticsTable]]);
        this.scenes.push(['radical_menu', [this.commonHanziMenu, this.hanziInfoPanel, this.commonHanziMenuControlStrip, this.numberInput]]);
        this.scenes.push(['common_hanzi_menu', [this.commonHanziMenu, this.hanziInfoPanel, this.commonHanziMenuControlStrip, this.numberInput]]);

        // hide menus on game start up
        this.switchScene('main_menu');
    }

    private loadData(){
        this.pinyinDatabase = new PinyinDatabase();
        this.characters = this.pinyinDatabase.characters;
        this.radicals = this.pinyinDatabase.radicals;
    }

    private loadSounds(){
        this.pinyinSound = this.assets.createSound('joined', { uri: `${this.baseUrl}/pinyin.ogg` });
        this.sprite = require('../public/json/sprite.json');
    }

    private getCharacters(){
        return this.currentScene == 'radical_menu' ? this.radicals : this.characters;
    }

    private getCommonHanziPageData(){
        let pageSize = this.commonHanziMenu.row * this.commonHanziMenu.col;
        return this.getCharacters().slice(pageSize*(this.commonHanziMenu.curPageNum-1), pageSize*this.commonHanziMenu.curPageNum);
    }

    private createRoot(){
        this.root = MRE.Actor.Create(this.context, {
            actor:{ 
                transform: { 
                    local: { position: {x: 0, y: 0, z: 0} }
                }
            },
        });
    }

    private createHomeButton(){
        const RADIUS = 0.02;
        this.home = MRE.Actor.CreatePrimitive(this.assets, {
            definition: {
                shape: MRE.PrimitiveShape.Sphere,
                dimensions: {x: RADIUS, y: RADIUS, z: RADIUS}
            },
            addCollider: true,
            actor: {
                name: 'home_button',
                parentId: this.root.id,
                transform: {
                    local: {
                        position: {x: -RADIUS, y: -RADIUS, z: 0},
                        scale: {x: 1, y: 1, z: 1}
                    }
                },
                appearance: {
                    enabled: true,
                    materialId: this.assets.createMaterial('home_button_material', { color: MRE.Color3.LightGray()}).id
                }
            },
        });
        let buttonBehavior = this.home.setBehavior(MRE.ButtonBehavior);
        buttonBehavior.onClick((user,__)=>{
            if(checkUserName(user, OWNER_NAME)){
                this.switchScene('main_menu');
            }
        });
    }

    private createMainMenu(){
        const MAIN_MENU_ITEMS = ['Pin Yin', 'Phonetics', 'Radicals', 'Common'];
        const MAIN_MENU_CELL_WIDTH = 0.6;
        const MAIN_MENU_CELL_HEIGHT = 0.2;
        const MAIN_MENU_CELL_DEPTH = 0.005;
        const MAIN_MENU_CELL_MARGIN = 0.01;
        const MAIN_MENU_CELL_SCALE = 1;

        // mainmenu button
        let mainMenuMeshId = this.assets.createBoxMesh('main_menu_btn_mesh', MAIN_MENU_CELL_WIDTH, MAIN_MENU_CELL_HEIGHT, MAIN_MENU_CELL_DEPTH).id;
        let mainMenuDefaultMaterialId = this.assets.createMaterial('main_menu_default_btn_material', { color: MRE.Color3.LightGray() }).id;

        let data = MAIN_MENU_ITEMS.map(t => [{
            text: t
        }]);
        this.mainMenu = new GridMenu(this.context, {
            // logic
            title: 'Main Menu',
            data,
            shape: {
                row: MAIN_MENU_ITEMS.length,
                col: 1
            },
            // assets
            meshId: mainMenuMeshId,
            defaultMaterialId: mainMenuDefaultMaterialId,
            // control
            parentId: this.root.id,
            // transform
            offset: {
                x: 0,
                y: 0
            },
            // dimensions
            margin: MAIN_MENU_CELL_MARGIN,
            box: {
                width: MAIN_MENU_CELL_WIDTH,
                height: MAIN_MENU_CELL_HEIGHT,
                depth: MAIN_MENU_CELL_DEPTH,
                scale: MAIN_MENU_CELL_SCALE,
                textHeight: 0.1,
            },
        });

        this.mainMenu.addBehavior((coord: Vector2, name: string, user: MRE.User) => {
            if (this.currentScene != 'main_menu') { return; }
            let row = coord.x;
            switch(row){
                case MAIN_MENU_ITEMS.indexOf('Pin Yin'):
                    this.switchScene('pinyin_menu');
                    break;
                case MAIN_MENU_ITEMS.indexOf('Phonetics'):
                    this.switchScene('phonetics_table');
                    break;
                case MAIN_MENU_ITEMS.indexOf('Radicals'):
                    this.switchScene('radical_menu');
                    this.hanziPageNum = this.commonHanziMenu.curPageNum;
                    if (this.radicalPageNum !== undefined) {
                        this.commonHanziMenu.setPageNum(this.radicalPageNum, this.getCharacters().length);
                    }
                    this.updateCommonHanziMenu( this.getCommonHanziPageData() );
                    break;
                case MAIN_MENU_ITEMS.indexOf('Common'):
                    this.switchScene('common_hanzi_menu');
                    this.radicalPageNum = this.commonHanziMenu.curPageNum;
                    if (this.hanziPageNum !== undefined) {
                        this.commonHanziMenu.setPageNum(this.hanziPageNum, this.getCharacters().length);
                    }
                    this.updateCommonHanziMenu( this.getCommonHanziPageData() );
                    break;
            }
        });
    }

    private createPinyinMenu(){
        const PINYIN_MENU_DIMENSIONS = new Vector2(6, 12);
        const PINYIN_MENU_CELL_WIDTH = 0.2;
        const PINYIN_MENU_CELL_HEIGHT = 0.2;
        const PINYIN_MENU_CELL_DEPTH = 0.005;
        const PINYIN_MENU_CELL_MARGIN = 0.010;
        const PINYIN_MENU_CELL_SCALE = 1;

        let pinyinMenuMeshId = this.assets.createBoxMesh('pinyin_menu_btn_mesh', PINYIN_MENU_CELL_WIDTH, PINYIN_MENU_CELL_HEIGHT, PINYIN_MENU_CELL_DEPTH).id;
        let pinyinMenuDefaultMaterialId = this.assets.createMaterial('pinyin_menu_default_btn_material', { color: MRE.Color3.LightGray() }).id;
        let pinyinMenuHighlightMeshId = this.assets.createBoxMesh('pinyin_menu_highlight_mesh', PINYIN_MENU_CELL_WIDTH+PINYIN_MENU_CELL_MARGIN, PINYIN_MENU_CELL_HEIGHT+PINYIN_MENU_CELL_MARGIN, PINYIN_MENU_CELL_DEPTH/2).id;
        let pinyinMenuHighlightMaterialId = this.assets.createMaterial('pinyin_menu_highlight_btn_material', { color: MRE.Color3.Red() }).id;

        let initials = this.breakDown(this.pinyinDatabase.initials, PINYIN_MENU_DIMENSIONS.y);
        let finals = this.breakDown(this.pinyinDatabase.finals, PINYIN_MENU_DIMENSIONS.y);
        let wholes = this.breakDown(this.pinyinDatabase.wholes, PINYIN_MENU_DIMENSIONS.y);
        let rl = [...initials, ...finals, ...wholes]; // row list
        let dl = [].concat(...rl); // datum list

        let data = rl.map(r=>{
            return r.map(d=>({text: d}));
        });

        this.pinyinMenu = new GridMenu(this.context, {
            data,
            // logic
            name: 'pinyin menu',
            title: 'The Pinyin Components Table',
            shape: {
                row: PINYIN_MENU_DIMENSIONS.x,
                col: PINYIN_MENU_DIMENSIONS.y
            },
            // asset
            meshId: pinyinMenuMeshId,
            defaultMaterialId: pinyinMenuDefaultMaterialId,
            highlightMeshId: pinyinMenuHighlightMeshId,
            highlightMaterialId: pinyinMenuHighlightMaterialId,
            // control
            parentId: this.root.id,
            // dimensions
            margin: PINYIN_MENU_CELL_MARGIN,
            box: {
                width: PINYIN_MENU_CELL_WIDTH,
                height: PINYIN_MENU_CELL_HEIGHT,
                depth: PINYIN_MENU_CELL_DEPTH,
                scale: PINYIN_MENU_CELL_SCALE,
                textColor: MRE.Color3.Black(),
                textHeight: 0.07,
                textAnchor: MRE.TextAnchorLocation.MiddleCenter
            },
            highlight: {
                depth: PINYIN_MENU_CELL_DEPTH/2
            }
        });
        this.pinyinMenu.addBehavior((coord: Vector2, name: string, user: MRE.User) => {
            if (this.currentScene != 'pinyin_menu') { return; }
            this.pinyinMenu.highlight(coord, true);
            let index = this.pinyinMenu.getHighlightedIndex(this.pinyinMenu.coord);
            this.putc(dl[index]);
        });
    }

    private createPinyinHead(){
        const PINYIN_HEAD_ITEMS = ['Initials', 'Finals', 'Wholes'];
        const PINYIN_HEAD_CELL_DEPTH = 0.005;
        const PINYIN_HEAD_CELL_MARGIN = this.pinyinMenu.margin;
        const PINYIN_HEAD_CELL_SCALE = 1;
        const PINYIN_HEAD_CELL_TEXT_HEIGHT = 0.09;

        // inventory info
        let PINYIN_HEAD_CELL_HEIGHT = this.pinyinMenu.boxHeight * 2 + this.pinyinMenu.margin;
        let PINYIN_HEAD_CELL_WIDTH = PINYIN_HEAD_CELL_HEIGHT;
        let pinyinHeadMeshId = this.assets.createBoxMesh('pinyin_head_mesh', PINYIN_HEAD_CELL_WIDTH, PINYIN_HEAD_CELL_HEIGHT, PINYIN_HEAD_CELL_DEPTH).id;
        let pinyinHeadMaterialId = this.assets.createMaterial('pinyin_head_material', { color: MRE.Color3.Teal() }).id;;

        let data = PINYIN_HEAD_ITEMS.map(d=>[{text: d}]);

        this.pinyinHead = new GridMenu(this.context, {
            data,
            // logic
            shape: {
                row: 3,
                col: 1
            },
            // assets
            meshId: pinyinHeadMeshId,
            defaultMaterialId: pinyinHeadMaterialId,
            // control
            parentId: this.root.id,
            // transform
            offset: {
                x: -(PINYIN_HEAD_CELL_WIDTH+PINYIN_HEAD_CELL_MARGIN),
                y: 0
            },
            // dimensions
            box: {
                width: PINYIN_HEAD_CELL_WIDTH,
                height: PINYIN_HEAD_CELL_HEIGHT,
                depth: PINYIN_HEAD_CELL_DEPTH,
                scale: PINYIN_HEAD_CELL_SCALE,
                textHeight: PINYIN_HEAD_CELL_TEXT_HEIGHT
            },
            margin: PINYIN_HEAD_CELL_MARGIN,
        });
    }

    private createPinyinTone(){
        const PINYIN_TONE_ITEMS = [ '1', '2', '3', '4'];
        const PINYIN_TONE_CELL_WIDTH = 0.2;
        const PINYIN_TONE_CELL_HEIGHT = 0.2;
        const PINYIN_TONE_CELL_DEPTH = 0.005;
        const PINYIN_TONE_CELL_MARGIN = 0.010;
        const PINYIN_TONE_CELL_SCALE = 1;
        const PINYIN_TONE_CELL_TEXT_HEIGHT = 0.09;

        // inventory info
        let pinyinToneMeshId = this.assets.createBoxMesh('pinyin_tone_mesh', PINYIN_TONE_CELL_WIDTH, PINYIN_TONE_CELL_HEIGHT, PINYIN_TONE_CELL_DEPTH).id;
        let pinyinToneMaterialId = this.assets.createMaterial('pinyin_tone_material', { color: MRE.Color3.Teal() }).id;;
        let pinyinToneHighlightMeshId = this.assets.createBoxMesh('pinyin_tone_highlight_mesh', PINYIN_TONE_CELL_WIDTH+PINYIN_TONE_CELL_MARGIN, PINYIN_TONE_CELL_HEIGHT+PINYIN_TONE_CELL_MARGIN, PINYIN_TONE_CELL_DEPTH/2).id;
        let pinyinToneHighlightMaterialId = this.assets.createMaterial('pinyin_tone_highlight_btn_material', { color: MRE.Color3.Red() }).id;

        let data = [ PINYIN_TONE_ITEMS.map((d=>({text: d}))) ];

        this.pinyinTone = new GridMenu(this.context, {
            data,
            // logic
            shape: {
                row: 1,
                col: 4
            },
            // assets
            meshId: pinyinToneMeshId,
            defaultMaterialId: pinyinToneMaterialId,
            highlightMeshId: pinyinToneHighlightMeshId,
            highlightMaterialId: pinyinToneHighlightMaterialId,
            // control
            parentId: this.root.id,
            // transform
            offset: {
                x: 0,
                y: -(PINYIN_TONE_CELL_HEIGHT + PINYIN_TONE_CELL_MARGIN)
            },
            // dimensions
            box: {
                width: PINYIN_TONE_CELL_WIDTH,
                height: PINYIN_TONE_CELL_HEIGHT,
                depth: PINYIN_TONE_CELL_DEPTH,
                scale: PINYIN_TONE_CELL_SCALE,
                textHeight: PINYIN_TONE_CELL_TEXT_HEIGHT
            },
            margin: PINYIN_TONE_CELL_MARGIN,
        });
        this.pinyinTone.addBehavior((coord: Vector2, name: string, user: MRE.User)=>{
            if (this.currentScene != 'pinyin_menu') { return; }
            this.pinyinTone.highlight(coord);
        });
    }

    private createPinyinMenuControlStrip(){
        const PINYIN_MENU_CONTROL_ITEMS = ['Backspace', 'Clear', 'Enter', 'Back'];
        const PINYIN_MENU_CONTROL_CELL_WIDTH = 0.3;
        const PINYIN_MENU_CONTROL_CELL_HEIGHT = this.pinyinTone.boxHeight;
        const PINYIN_MENU_CONTROL_CELL_DEPTH = 0.0005;
        const PINYIN_MENU_CONTROL_CELL_MARGIN = 0.0075;
        const PINYIN_MENU_CONTROL_CELL_SCALE = 1;
        const PINYIN_MENU_CONTROL_CELL_TEXT_HEIGHT = 0.05;

        let pinyinMenuControlMeshId = this.assets.createBoxMesh('pinyin_menu_control_btn_mesh', PINYIN_MENU_CONTROL_CELL_WIDTH, PINYIN_MENU_CONTROL_CELL_HEIGHT, PINYIN_MENU_CONTROL_CELL_DEPTH).id;
        let pinyinMenuControlDefaultMaterialId = this.assets.createMaterial('pinyin_menu_control_default_btn_material', { color: MRE.Color3.DarkGray() }).id;

        let data = [ PINYIN_MENU_CONTROL_ITEMS.map(t => ({
            text: t
        })) ];

        this.pinyinMenuControlStrip = new GridMenu(this.context, {
            // logic
            data,
            shape: {
                row: 1,
                col: PINYIN_MENU_CONTROL_ITEMS.length
            },
            // assets
            meshId: pinyinMenuControlMeshId,
            defaultMaterialId: pinyinMenuControlDefaultMaterialId,
            // control
            parentId: this.root.id,
            // transform
            offset: {
                x: this.pinyinTone.getMenuSize().width + this.pinyinTone.margin,
                y: -(this.pinyinTone.margin + PINYIN_MENU_CONTROL_CELL_HEIGHT)
            },
            // dimensions
            margin: PINYIN_MENU_CONTROL_CELL_MARGIN,
            box: {
                width: PINYIN_MENU_CONTROL_CELL_WIDTH,
                height: PINYIN_MENU_CONTROL_CELL_HEIGHT,
                depth: PINYIN_MENU_CONTROL_CELL_DEPTH,
                scale: PINYIN_MENU_CONTROL_CELL_SCALE,
                textHeight: PINYIN_MENU_CONTROL_CELL_TEXT_HEIGHT,
                textColor: MRE.Color3.White()
            },
        });
        this.pinyinMenuControlStrip.addBehavior((coord: Vector2, name: string, user: MRE.User) => {
            if (this.currentScene != 'pinyin_menu') { return; }
            let col = coord.y;
            switch(col){
                case PINYIN_MENU_CONTROL_ITEMS.indexOf('Backspace'):
                    this.putc('Backspace')
                    break;
                case PINYIN_MENU_CONTROL_ITEMS.indexOf('Clear'):
                    this.putc('Clear')
                    break;
                case PINYIN_MENU_CONTROL_ITEMS.indexOf('Enter'):
                    this.putc('Enter')
                    break;
                case PINYIN_MENU_CONTROL_ITEMS.indexOf('Back'):
                    this.switchScene('main_menu')
                    break;
            }
        });
    }

    private createPinyinInfoPanel(){
        const PINYIN_INFO_CELL_HEIGHT = 0.2;
        const PINYIN_INFO_CELL_DEPTH = 0.005;
        const PINYIN_INFO_CELL_MARGIN = 0.005;
        const PINYIN_INFO_CELL_SCALE = 1;
        const PINYIN_INFO_CELL_TEXT_HEIGHT = 0.09;

        // inventory info
        const w = this.pinyinTone.getMenuSize().width + this.pinyinTone.margin + this.pinyinMenuControlStrip.getMenuSize().width;
        const PINYIN_INFO_CELL_WIDTH = w;
        let pinyinInfoMeshId = this.assets.createBoxMesh('pinyin_info_mesh', PINYIN_INFO_CELL_WIDTH, PINYIN_INFO_CELL_HEIGHT, PINYIN_INFO_CELL_DEPTH).id;
        let pinyinInfoMaterialId = this.assets.createMaterial('pinyin_info_material', { color: MRE.Color3.White() }).id;;

        let data = [[{text: PINYIN_INFO_PLACE_HOLDER}]];

        this.pinyinInfoPanel = new GridMenu(this.context, {
            data,
            // logic
            shape: {
                row: 1,
                col: 1
            },
            // assets
            meshId: pinyinInfoMeshId,
            defaultMaterialId: pinyinInfoMaterialId,
            // control
            parentId: this.root.id,
            // transform
            offset: {
                x: 0,
                y: -(this.pinyinTone.margin + this.pinyinTone.getMenuSize().height + PINYIN_INFO_CELL_MARGIN + PINYIN_INFO_CELL_HEIGHT)
            },
            // dimensions
            box: {
                width: PINYIN_INFO_CELL_WIDTH,
                height: PINYIN_INFO_CELL_HEIGHT,
                depth: PINYIN_INFO_CELL_DEPTH,
                scale: PINYIN_INFO_CELL_SCALE,
                textHeight: PINYIN_INFO_CELL_TEXT_HEIGHT
            },
            margin: PINYIN_INFO_CELL_MARGIN,
        });
    }

    private createPhoneticsTable(){
        const PHONETICS_TABLE_DIMENSIONS = new Vector2(this.pinyinDatabase.rowNum+1, this.pinyinDatabase.colNum+1);
        const PHONETICS_TABLE_CELL_WIDTH = 0.035;
        const PHONETICS_TABLE_CELL_HEIGHT = 0.035;
        const PHONETICS_TABLE_CELL_DEPTH = 0.005;
        const PHONETICS_TABLE_CELL_MARGIN = 0.003;
        const PHONETICS_TABLE_CELL_SCALE = 1;

        let phoneticsTableMeshId = this.assets.createBoxMesh('phonetics_table_btn_mesh', PHONETICS_TABLE_CELL_WIDTH, PHONETICS_TABLE_CELL_HEIGHT, PHONETICS_TABLE_CELL_DEPTH).id;
        let phoneticsTableDefaultMaterialId = this.assets.createMaterial('phonetics_table_default_btn_material', { color: MRE.Color3.LightGray() }).id;
        let phoneticsTableHighlightMeshId = this.assets.createBoxMesh('phonetics_table_highlight_mesh', PHONETICS_TABLE_CELL_WIDTH+PHONETICS_TABLE_CELL_MARGIN, PHONETICS_TABLE_CELL_HEIGHT+PHONETICS_TABLE_CELL_MARGIN, PHONETICS_TABLE_CELL_DEPTH/2).id;
        let phoneticsTableHighlightMaterialId = this.assets.createMaterial('phonetics_table_highlight_btn_material', { color: MRE.Color3.Red() }).id;
        let phoneticsTablePlaneMeshId = this.assets.createPlaneMesh('plane_mesh', PHONETICS_TABLE_CELL_WIDTH, PHONETICS_TABLE_CELL_HEIGHT).id;
        let phoneticsTablePlaneBodyMaterial = this.assets.createMaterial('body_btn_material', { color: MRE.Color3.LightGray() });
        let phoneticsTablePlaneHeadMaterial = this.assets.createMaterial('head_btn_material', { color: MRE.Color3.Teal() });

        let head = [ '', ...this.pinyinDatabase.cols ];
        let body = this.pinyinDatabase.phonetics.map((d: string[],i: number) => {return [this.pinyinDatabase.rows[i], ...d]});
        let data = [ head, ...body ].map((r, i)=>{
            if (i==0){ // first row?
                return r.map((d: CellData)=>({text: d, material: phoneticsTablePlaneHeadMaterial}));
            }else{
                return r.map(((d: CellData, i: number)=>(
                    (i==0) ? {text: d, material: phoneticsTablePlaneHeadMaterial} : {text: d}
                )))
            }
        });

        this.phoneticsTable = new GridMenu(this.context, {
            data,
            // logic
            name: 'phonetics table',
            title: 'The Pinyin Phonetics Table',
            shape: {
                row: PHONETICS_TABLE_DIMENSIONS.x,
                col: PHONETICS_TABLE_DIMENSIONS.y
            },
            // asset
            meshId: phoneticsTableMeshId,
            defaultMaterialId: phoneticsTableDefaultMaterialId,
            highlightMeshId: phoneticsTableHighlightMeshId,
            highlightMaterialId: phoneticsTableHighlightMaterialId,
            planeMeshId: phoneticsTablePlaneMeshId,
            defaultPlaneMaterial: phoneticsTablePlaneBodyMaterial,
            // control
            parentId: this.root.id,
            // dimensions
            margin: PHONETICS_TABLE_CELL_MARGIN,
            box: {
                width: PHONETICS_TABLE_CELL_WIDTH,
                height: PHONETICS_TABLE_CELL_HEIGHT,
                depth: PHONETICS_TABLE_CELL_DEPTH,
                scale: PHONETICS_TABLE_CELL_SCALE,
                textColor: MRE.Color3.Black(),
                textHeight: 0.01,
                textAnchor: MRE.TextAnchorLocation.MiddleCenter
            },
            highlight: {
                depth: PHONETICS_TABLE_CELL_DEPTH/2
            }
        });
        this.phoneticsTable.addBehavior((coord: Vector2, name: string, user: MRE.User) => {
            if (this.currentScene != 'phonetcis_table') { return; }
            this.phoneticsTable.highlight(coord);
        });
    }

    private createPhoneticsPanel(){
        const PHONETICS_PANEL_DIMENSIONS = new Vector2(this.pinyinDatabase.rowNum+1, this.pinyinDatabase.colNum+1);
        const PHONETICS_PANEL_CELL_WIDTH = 0.07;
        const PHONETICS_PANEL_CELL_DEPTH = 0.005;
        const PHONETICS_PANEL_CELL_MARGIN = 0.003;
        const PHONETICS_PANEL_CELL_SCALE = 1;
        const w = PHONETICS_PANEL_CELL_WIDTH*PHONETICS_PANEL_DIMENSIONS.y;
        const h = w/3067*1673;

        let phoneticsPanelMeshId = this.assets.createBoxMesh('phonetics_panel_btn_mesh', w, h, PHONETICS_PANEL_CELL_DEPTH).id;
        let phoneticsPanelMaterialId = this.assets.createMaterial('phonetics_panel_default_btn_material', { color: MRE.Color3.LightGray() }).id;
        let phoneticsPanelPlaneMeshId = this.assets.createPlaneMesh('phonetics_panel_plane_mesh', w, h).id;
        let phoneticsPanleTexture = this.assets.createTexture('phonetics_panel_texture', {uri: 'phonetics.png'});
        let phoneticsPanelPlaneMaterial = this.assets.createMaterial('phonetics_panel_material', {mainTextureId: phoneticsPanleTexture.id});

        let data = [[{text: '', material: phoneticsPanelPlaneMaterial}]];

        this.phoneticsTable = new GridMenu(this.context, {
            data,
            // logic
            name: 'phonetics table',
            title: 'The Pinyin Phonetics Table',
            shape: {
                row: 1,
                col: 1
            },
            // asset
            meshId: phoneticsPanelMeshId,
            defaultMaterialId: phoneticsPanelMaterialId,
            planeMeshId: phoneticsPanelPlaneMeshId,
            defaultPlaneMaterial: phoneticsPanelPlaneMaterial,
            // control
            parentId: this.root.id,
            // dimensions
            margin: PHONETICS_PANEL_CELL_MARGIN,
            box: {
                width: w,
                height: h,
                depth: PHONETICS_PANEL_CELL_DEPTH,
                scale: PHONETICS_PANEL_CELL_SCALE
            }
        });
    }

    private createCommonHanziMenu(){
        const COMMON_HANZI_MENU_DIMENSIONS = new Vector2(8, 8);
        const COMMON_HANZI_MENU_CELL_WIDTH = 0.2;
        const COMMON_HANZI_MENU_CELL_HEIGHT = 0.2;
        const COMMON_HANZI_MENU_CELL_DEPTH = 0.005;
        const COMMON_HANZI_MENU_CELL_MARGIN = 0.01;
        const COMMON_HANZI_MENU_CELL_SCALE = 1;

        let commonHanziMenuMeshId = this.assets.createBoxMesh('common_hanzi_menu_btn_mesh', COMMON_HANZI_MENU_CELL_WIDTH, COMMON_HANZI_MENU_CELL_HEIGHT, COMMON_HANZI_MENU_CELL_DEPTH).id;
        let commonHanziMenuDefaultMaterialId = this.assets.createMaterial('common_hanzi_menu_default_btn_material', { color: MRE.Color3.LightGray() }).id;
        let commonHanziMenuHighlightMeshId = this.assets.createBoxMesh('common_hanzi_menu_highlight_mesh', COMMON_HANZI_MENU_CELL_WIDTH+COMMON_HANZI_MENU_CELL_MARGIN, COMMON_HANZI_MENU_CELL_HEIGHT+COMMON_HANZI_MENU_CELL_MARGIN, COMMON_HANZI_MENU_CELL_DEPTH/2).id;
        let commonHanziMenuHighlightMaterialId = this.assets.createMaterial('common_hanzi_menu_highlight_btn_material', { color: MRE.Color3.Red() }).id;
        let commonHanziMenuPlaneMeshId = this.assets.createPlaneMesh('common_hanzi_menu_plane_mesh', COMMON_HANZI_MENU_CELL_WIDTH, COMMON_HANZI_MENU_CELL_HEIGHT).id;
        let commonHanziMenuPlaneDefaultMaterial = this.assets.createMaterial('common_hanzi_menu_plane_material', { color: MRE.Color3.DarkGray() });

        this.commonHanziMenu = new GridMenu(this.context, {
            // logic
            name: 'commnon hanzi menu',
            title: '2497 Common Hanzi Characters',
            shape: {
                row: COMMON_HANZI_MENU_DIMENSIONS.x,
                col: COMMON_HANZI_MENU_DIMENSIONS.y
            },
            // asset
            meshId: commonHanziMenuMeshId,
            defaultMaterialId: commonHanziMenuDefaultMaterialId,
            highlightMeshId: commonHanziMenuHighlightMeshId,
            highlightMaterialId: commonHanziMenuHighlightMaterialId,
            planeMeshId: commonHanziMenuPlaneMeshId,
            defaultPlaneMaterial: commonHanziMenuPlaneDefaultMaterial,
            // control
            parentId: this.root.id,
            // dimensions
            margin: COMMON_HANZI_MENU_CELL_MARGIN,
            box: {
                width: COMMON_HANZI_MENU_CELL_WIDTH,
                height: COMMON_HANZI_MENU_CELL_HEIGHT,
                depth: COMMON_HANZI_MENU_CELL_DEPTH,
                scale: COMMON_HANZI_MENU_CELL_SCALE,
                textColor: MRE.Color3.Black(),
                textHeight: 0.008,
                textAnchor: MRE.TextAnchorLocation.TopLeft
            },
            highlight: {
                depth: COMMON_HANZI_MENU_CELL_DEPTH/2
            },
            plane: {
                width: COMMON_HANZI_MENU_CELL_WIDTH,
                height: COMMON_HANZI_MENU_CELL_HEIGHT
            },
        });
        this.commonHanziMenu.offsetLabels({x: -COMMON_HANZI_MENU_CELL_WIDTH/2, y: COMMON_HANZI_MENU_CELL_HEIGHT/2});
        this.commonHanziMenu.addBehavior((coord: Vector2, name: string, user: MRE.User) => {
            if (this.currentScene != 'common_hanzi_menu' && this.currentScene != 'radical_menu') { return; }
            this.commonHanziMenu.highlight(coord);
            let index = this.commonHanziMenu.getHighlightedIndex(this.commonHanziMenu.coord);
            let char = this.getCharacters()[index];
            this.updateHanziInfoPanel(char);
        });
    }

    private createHanziInfoPanel(){
        const HANZI_INFO_CELL_HEIGHT = this.commonHanziMenu.boxWidth*3 + this.commonHanziMenu.margin*2;
        const HANZI_INFO_CELL_DEPTH = 0.005;
        const HANZI_INFO_CELL_MARGIN = 0.005;
        const HANZI_INFO_CELL_SCALE = 1;
        const HANZI_INFO_CELL_TEXT_HEIGHT = 0.045;

        const HANZI_INFO_PLANE_HEIGHT = HANZI_INFO_CELL_HEIGHT;
        const HANZI_INFO_PLANE_WIDTH = HANZI_INFO_PLANE_HEIGHT;

        // inventory info
        const w = this.commonHanziMenu.getMenuSize().width;
        const HANZI_INFO_CELL_WIDTH = w;
        let hanziInfoMeshId = this.assets.createBoxMesh('hanzi_info_mesh', HANZI_INFO_CELL_WIDTH, HANZI_INFO_CELL_HEIGHT, HANZI_INFO_CELL_DEPTH).id;
        let hanziInfoMaterialId = this.assets.createMaterial('hanzi_info_material', { color: MRE.Color3.White() }).id;;
        let hanziInfoPlaneMeshId = this.assets.createPlaneMesh('hanzi_info_plane_mesh', HANZI_INFO_PLANE_WIDTH, HANZI_INFO_PLANE_HEIGHT).id;
        let hanziInfoPlaneMaterial = this.assets.createMaterial('hanzi_info_material', { color: MRE.Color3.LightGray()});

        let data = [[{text: ''}]];

        this.hanziInfoPanel = new GridMenu(this.context, {
            data,
            // logic
            shape: {
                row: 1,
                col: 1
            },
            // assets
            meshId: hanziInfoMeshId,
            defaultMaterialId: hanziInfoMaterialId,
            planeMeshId: hanziInfoPlaneMeshId,
            defaultPlaneMaterial: hanziInfoPlaneMaterial,
            // control
            parentId: this.root.id,
            // transform
            offset: {
                x: 0,
                y: -(HANZI_INFO_CELL_HEIGHT + HANZI_INFO_CELL_MARGIN)
            },
            // dimensions
            box: {
                width: HANZI_INFO_CELL_WIDTH,
                height: HANZI_INFO_CELL_HEIGHT,
                depth: HANZI_INFO_CELL_DEPTH,
                scale: HANZI_INFO_CELL_SCALE,
                textHeight: HANZI_INFO_CELL_TEXT_HEIGHT
            },
            plane: {
                width: HANZI_INFO_PLANE_WIDTH,
                height: HANZI_INFO_PLANE_HEIGHT
            },
            margin: HANZI_INFO_CELL_MARGIN,
        });
        this.hanziInfoPanel.planesAlignLeft();
        this.hanziInfoPanel.labelsRightToPlane();
    }

    private createCommonHanziMenuControlStrip(){
        const COMMON_HANZI_MENU_CONTROL_ITEMS = ['Search', 'Goto', 'Prev', 'Next', 'Spawn', 'Delete', 'Save', 'Load', 'Clear'];
        const COMMON_HANZI_MENU_CONTROL_CELL_MARGIN = 0.0075;
        const COMMON_HANZI_MENU_CONTROL_CELL_WIDTH = (this.commonHanziMenu.getMenuSize().width + COMMON_HANZI_MENU_CONTROL_CELL_MARGIN)/COMMON_HANZI_MENU_CONTROL_ITEMS.length - COMMON_HANZI_MENU_CONTROL_CELL_MARGIN;
        const COMMON_HANZI_MENU_CONTROL_CELL_HEIGHT = this.commonHanziMenu.boxHeight;
        const COMMON_HANZI_MENU_CONTROL_CELL_DEPTH = 0.0005;
        const COMMON_HANZI_MENU_CONTROL_CELL_SCALE = 1;
        const COMMON_HANZI_MENU_CONTROL_CELL_TEXT_HEIGHT = 0.04;

        let commonHanziMenuControlMeshId = this.assets.createBoxMesh('pinyin_menu_control_btn_mesh', COMMON_HANZI_MENU_CONTROL_CELL_WIDTH, COMMON_HANZI_MENU_CONTROL_CELL_HEIGHT, COMMON_HANZI_MENU_CONTROL_CELL_DEPTH).id;
        let commonHanziMenuControlDefaultMaterialId = this.assets.createMaterial('pinyin_menu_control_default_btn_material', { color: MRE.Color3.DarkGray() }).id;

        let data = [ COMMON_HANZI_MENU_CONTROL_ITEMS.map(t => ({
            text: t
        })) ];

        this.commonHanziMenuControlStrip = new GridMenu(this.context, {
            // logic
            data,
            shape: {
                row: 1,
                col: COMMON_HANZI_MENU_CONTROL_ITEMS.length
            },
            // assets
            meshId: commonHanziMenuControlMeshId,
            defaultMaterialId: commonHanziMenuControlDefaultMaterialId,
            // control
            parentId: this.root.id,
            // transform
            offset: {
                x: 0,
                y: -(this.hanziInfoPanel.getMenuSize().height + this.hanziInfoPanel.margin + COMMON_HANZI_MENU_CONTROL_CELL_HEIGHT + COMMON_HANZI_MENU_CONTROL_CELL_MARGIN)
            },
            // dimensions
            margin: COMMON_HANZI_MENU_CONTROL_CELL_MARGIN,
            box: {
                width: COMMON_HANZI_MENU_CONTROL_CELL_WIDTH,
                height: COMMON_HANZI_MENU_CONTROL_CELL_HEIGHT,
                depth: COMMON_HANZI_MENU_CONTROL_CELL_DEPTH,
                scale: COMMON_HANZI_MENU_CONTROL_CELL_SCALE,
                textHeight: COMMON_HANZI_MENU_CONTROL_CELL_TEXT_HEIGHT,
                textColor: MRE.Color3.White()
            },
        });
        this.commonHanziMenuControlStrip.addBehavior((coord: Vector2, name: string, user: MRE.User) => {
            if (this.currentScene != 'common_hanzi_menu' && this.currentScene != 'radical_menu') { return; }
            let col = coord.y;
            switch(col){
                case COMMON_HANZI_MENU_CONTROL_ITEMS.indexOf('Search'):
                    user.prompt("Search Hanzi", true).then((dialog) => {
                        if (dialog.submitted) {
                            this.searchHanzi(dialog.text);
                            this.commonHanziMenu.resetPageNum();
                            this.updateCommonHanziMenu( this.getCommonHanziPageData() );
                        }
                    });
                    break;
                case COMMON_HANZI_MENU_CONTROL_ITEMS.indexOf('Goto'):
                    user.prompt("Goto page", true).then((dialog) => {
                        if (dialog.submitted) {
                            let p = parseInt(dialog.text);
                            if (p!==NaN){
                                this.commonHanziMenu.setPageNum(p, this.getCharacters().length);
                                this.updateCommonHanziMenu( this.getCommonHanziPageData() );
                            }
                        }
                    });
                    break;
                case COMMON_HANZI_MENU_CONTROL_ITEMS.indexOf('Prev'):
                    this.commonHanziMenu.decrementPageNum();
                    this.updateCommonHanziMenu( this.getCommonHanziPageData() );
                    break;
                case COMMON_HANZI_MENU_CONTROL_ITEMS.indexOf('Next'):
                    this.commonHanziMenu.incrementPageNum( this.getCharacters().length );
                    this.updateCommonHanziMenu( this.getCommonHanziPageData() );
                    break;
                case COMMON_HANZI_MENU_CONTROL_ITEMS.indexOf('Spawn'):
                    let index = this.commonHanziMenu.getHighlightedIndex(this.commonHanziMenu.coord);
                    let char = this.getCharacters()[index];
                    this.spawnItem(char);
                    break;
                case COMMON_HANZI_MENU_CONTROL_ITEMS.indexOf('Delete'):
                    if (this.highlightedActor != null){
                        this.deleteItem(this.highlightedActor);
                    }
                    break;
                case COMMON_HANZI_MENU_CONTROL_ITEMS.indexOf('Save'):
                    user.prompt("Save as:", true).then((dialog) => {
                        if (dialog.submitted) {
                            let filename = dialog.text;
                            this.saveLevel(filename, user);
                        }
                    });
                    break;
                case COMMON_HANZI_MENU_CONTROL_ITEMS.indexOf('Load'):
                    user.prompt("Load from:", true).then((dialog) => {
                        if (dialog.submitted) {
                            let filename = dialog.text;
                            this.loadLevel(filename, user);
                        }
                    });
                    break;
                case COMMON_HANZI_MENU_CONTROL_ITEMS.indexOf('Clear'):
                    user.prompt("Clear level?", false).then((dialog) => {
                        if (dialog.submitted) {
                            this.clearLevel();
                        }
                    });
                    break;
            }
        });
    }

    private createNumberInput(){
        const NUMBER_INPUT_CELL_MARGIN = 0.005;
        const NUMBER_INPUT_CELL_WIDTH = (this.commonHanziMenu.getMenuSize().width + NUMBER_INPUT_CELL_MARGIN)/3 - NUMBER_INPUT_CELL_MARGIN;
        const NUMBER_INPUT_CELL_HEIGHT = 0.1;
        const NUMBER_INPUT_CELL_DEPTH = 0.005;
        const NUMBER_INPUT_CELL_SCALE = 1;
        const NUMBER_INPUT_CELL_TEXT_HEIGHT = 0.05;

        let numberInputMeshId = this.assets.createBoxMesh('number_input_btn_mesh', NUMBER_INPUT_CELL_WIDTH, NUMBER_INPUT_CELL_HEIGHT, NUMBER_INPUT_CELL_DEPTH).id;
        let numberInputMaterialId = this.assets.createMaterial('number_input_btn_material', { color: MRE.Color3.LightGray() }).id;

        let h1 = this.commonHanziMenuControlStrip.getMenuSize().height + this.commonHanziMenuControlStrip.margin;
        let h2 = this.hanziInfoPanel.getMenuSize().height + this.hanziInfoPanel.margin;

        this.numberInput = new NumberInput(this.context, {
            // logic
            shape: {
                row: 1,
                col: 3
            },
            // assets
            meshId: numberInputMeshId,
            defaultMaterialId: numberInputMaterialId,
            // control
            parentId: this.root.id,
            // transform
            offset: {
                x: 0,
                y: -(h1 + h2 + NUMBER_INPUT_CELL_MARGIN + NUMBER_INPUT_CELL_HEIGHT)
            },
            // dimensions
            box: {
                width: NUMBER_INPUT_CELL_WIDTH,
                height: NUMBER_INPUT_CELL_HEIGHT,
                depth: NUMBER_INPUT_CELL_DEPTH,
                scale: NUMBER_INPUT_CELL_SCALE,
                textHeight: NUMBER_INPUT_CELL_TEXT_HEIGHT
            },
            margin: NUMBER_INPUT_CELL_MARGIN,
        });

        this.numberInput.onIncrease(()=>{
            if (this.currentScene != 'common_hanzi_menu' && this.currentScene != 'radical_menu') { return; }
            if (this.highlightedActor != null){
                let box = this.highlightBoxes.get(this.highlightedActor);
                let scale = box.transform.local.scale;
                scale.x += SCALE_STEP;
                scale.y += SCALE_STEP;
                scale.z += SCALE_STEP;
                this.numberInput.updateText((scale.x/HANZI_MODEL_SCALE).toString());
            }
        });

        this.numberInput.onDecrease(()=>{
            if (this.currentScene != 'common_hanzi_menu' && this.currentScene != 'radical_menu') { return; }
            if (this.highlightedActor != null){
                let box = this.highlightBoxes.get(this.highlightedActor);
                let scale = box.transform.local.scale;
                scale.x -= SCALE_STEP;
                scale.y -= SCALE_STEP;
                scale.z -= SCALE_STEP;
                this.numberInput.updateText((scale.x/HANZI_MODEL_SCALE).toString());
            }
        });
        this.numberInput.onEdit((user)=>{
            if (this.currentScene != 'common_hanzi_menu' && this.currentScene != 'radical_menu') { return; }
            if (this.highlightedActor != null){
                user.prompt("Change scale to", true).then((dialog) => {
                    if (dialog.submitted) {
                        let int = parseInt(dialog.text)*HANZI_MODEL_SCALE;
                        if(int !== NaN){
                            let box = this.highlightBoxes.get(this.highlightedActor);
                            let scale = box.transform.local.scale;
                            scale.x = int;
                            scale.y = int;
                            scale.z = int;
                            this.numberInput.updateText((scale.x/HANZI_MODEL_SCALE).toString());
                        }
                    }
                });
            }
        })
    }

    /////////////////
    // scenes
    private switchScene(scene: string){
        if (this.currentScene == scene){
            return;
        }
        // default scene
        if (!this.currentScene.length && !this.scenes.map(e=>e[0]).includes(scene)) {
            scene = 'main_menu';
        }
        this.currentScene = scene;
        // disable other scenes first
        let tv: GridMenu[] = [];
        this.scenes.forEach((e)=>{
            let k = e[0]; let v = e[1];
            v.forEach(m => {
                if (k != scene){
                    m.disable();
                }
                else{
                    tv = v;
                }
            });
        });
        // then enable current scene
        tv.forEach(m => {
            m.enable();
        })
    }

    ////////////////
    // utils
    private height(arr: string[], width: number){
        return Math.floor(arr.length / width) + (arr.length % width ? 1 : 0);
    }
    private breakDown(arr: string[], width: number){
        const h = this.height(arr, width);
        const ret = [];
        for (var i=0; i < h-1; i++) {
          ret.push( arr.slice( i*width, (i+1)*width ) );
        }
        ret.push( arr.slice( (i)*width ).concat(Array(h*width-arr.length).fill('')) );
        return ret;
    }

    /////////////////
    // actions
    private putc(c: string){
        var error = false;
        
        switch(c){
        case 'Backspace':
            this.pinyinInfoText = this.pinyinInfoText.slice(0,-1);
            break;
        case 'Clear':
            this.pinyinInfoText = '';
            this.pinyinMenu.highlight(this.pinyinMenu.coord, false);
            break;
        case 'Enter':
            if ( this.pinyinInfoText && this.pinyinDatabase.syllables.includes(this.pinyinInfoText) ){
                let tone = (this.pinyinTone.highlighted) ? (this.pinyinTone.coord.y+1).toString() : '';
                this.playSound(this.pinyinInfoText.replace('ü','v') + tone);
                console.log(this.pinyinInfoText.replace('ü','v')+tone);
            }
            else{
                error = true;
            }
            this.pinyinInfoText = '';
            this.pinyinMenu.highlight(this.pinyinMenu.coord, false);
            break;
        default:
            this.pinyinInfoText += c;
            if ( !this.pinyinDatabase.find(this.pinyinInfoText) ) {
                error = true;
                this.pinyinInfoText = '';
                this.pinyinMenu.highlight(this.pinyinMenu.coord, false);
            }
        }

        this.updatePinyinInfoPanel( (this.pinyinInfoText ? this.pinyinInfoText : (error ? PINYIN_INFO_ERROR_MESSAGE : PINYIN_INFO_PLACE_HOLDER) ) );
    }

    private updatePinyinInfoPanel(text: string){
        this.pinyinInfoPanel.updateCells([[{text: text}]]);
    }

    private updateCommonHanziMenu(pageData: string[]){
        let data = pageData.map(d => {
            let code = d.charCodeAt(0).toString();
            let url = new URL(`${code}.png`, THUMBNAILS_BASE_URL).toString();
            return {
                text: parseInt(code).toString(16).toUpperCase(),
                material: this.loadMaterial(code, url)
            }
        });
        this.commonHanziMenu.updateCells(this.commonHanziMenu.reshape(data));
    }

    private updateHanziInfoPanel(char: string){
        if (char === undefined) return;
        let code = char.charCodeAt(0).toString();
        let url = new URL(`${code}.png`, THUMBNAILS_BASE_URL).toString();
        let info = this.pinyinDatabase.dictionary[char];
        let desc = `PinYin: ${info.pinyin}\nStrokes: ${info.stroke}\nEnglish: ${info.english}`;
        this.hanziInfoPanel.updateCells([[{
            text: lineBreak(desc, 40),
            material: this.loadMaterial(code, url)
        }]]);
    }

    private playSound(text: string){
        let s = this.sprite[text];
        if (s === undefined) return;
        let m = this.root.startSound(this.pinyinSound.id, {
            volume: 1,
            rolloffStartDistance: 100,
            time: parseInt(s[0])/1000
        });

        setTimeout(()=>{
          m.stop();
        }, parseInt(s[1]));
    }

    private searchHanzi(search: string = ''){
        if (this.currentScene == 'common_hanzi_menu'){
            if(!search.length){
                this.characters = this.pinyinDatabase.characters;
            }else{
                this.characters = this.pinyinDatabase.characters.filter((c: string) => {
                    return this.pinyinDatabase.dictionary[c].pinyin.includes(search);
                });
            }
        }else{
            if(!search.length){
                this.radicals = this.pinyinDatabase.radicals;
            }else{
                this.radicals = this.pinyinDatabase.radicals.filter((c: string) => {
                    return this.pinyinDatabase.dictionary[c].pinyin.includes(search);
                });
            }
        }
    }

    ////////////////////
    //// material
    private loadMaterial(name: string, uri: string){
        let texture;
        if (!this.textures.has('texture_'+name)){
            texture = this.assets.createTexture('texture_'+name, {uri});
            this.textures.set('texture_'+name, texture);
        }else{
            texture = this.textures.get('texture_'+name);
        }

        let material;
        if(!this.materials.has('material_'+name)){
            material = this.assets.createMaterial('material_'+name, { color: MRE.Color3.White(), mainTextureId: texture.id });
            this.materials.set('material_'+name, material);
        }else{
            material = this.materials.get('material_'+name);
        }
        return material;
    }

    private async loadGltf(char: string, uri: string){
        let url = joinUrl(this.baseUrl +'/', uri);
        if (!this.prefabs.has(char)){
            let obj = await getGltf(url);
            let dim = gltfBoundingBox.computeBoundings(obj);
            
            await this.assets.loadGltf(url)
                .then(assets => {
                    this.prefabs.set(char, assets.find(a => a.prefab !== null) as MRE.Prefab);
                    this.dimensions.set(char, dim);
                })
                .catch(e => MRE.log.info("app", e));
        }
        return this.prefabs.get(char);
    }
    private async spawnItem(char: string, _transform?: MRE.ActorTransformLike, editor: boolean = true){
        console.log('spawn', char);
        if (char === undefined) return;

        let code = char.charCodeAt(0).toString();
        let url = new URL(`${code}.glb`, MODELS_BASE_URL).toString();
        let prefab = await this.loadGltf(char, url);

        let dim = this.dimensions.get(char).dimensions;
        let center = this.dimensions.get(char).center;

        let size = this.commonHanziMenu.getMenuSize();
        let pos = {x: size.width + 0.05 + dim.width*HANZI_MODEL_SCALE/2, y: -dim.height*HANZI_MODEL_SCALE/2, z: 0};
        let transform = (_transform !== undefined) ? _transform : {
            app: {
                position: {x: pos.x, y: pos.y, z: 0}
            },
            local: {
                position: {x: pos.x, y: pos.y, z: 0},
                scale: {x: HANZI_MODEL_SCALE, y: HANZI_MODEL_SCALE, z: HANZI_MODEL_SCALE},
                rotation: HANZI_MODEL_ROTATION
            }
        }; 

        let box = MRE.Actor.CreatePrimitive(this.assets, {
            definition: {
                shape: MRE.PrimitiveShape.Box,
                dimensions: {x: dim.width, y: dim.height, z: dim.depth}
            },
            addCollider: true,
            actor: {
                name: code,
                transform,
                appearance: {
                    materialId: this.invisibleMaterial.id
                },
                collider: {
                    geometry: {
                        shape: MRE.ColliderType.Auto
                    }
                },
                grabbable: editor ? true : false
            },
        });

        // subscribe to box transform
        if (editor) box.subscribe('transform');

        let actor = MRE.Actor.CreateFromPrefab(this.context, {
            prefabId: prefab.id,
            actor: {
                parentId: box.id,
                collider: { 
                    geometry: { shape: MRE.ColliderType.Box },
                    layer: MRE.CollisionLayer.Hologram
                },
                transform:{
                    local: {
                        position: {x: center.x, y: -center.z, z: 0},
                        scale: {x: 1, y: 1, z: 1}
                    }
                },
                grabbable: editor ? true : false
            }
        });

        // remember box
        this.highlightBoxes.set(actor, box);
            
        // remember model character
        this.spawnedHanzi.set(box, char);
        if (editor){
            // add behavior
            let buttonBehavior = box.setBehavior(MRE.ButtonBehavior);
            buttonBehavior.onClick((user,__)=>{
                if(checkUserName(user, OWNER_NAME)){
                    if (this.highlightedActor != actor){
                        if (this.highlightedActor != null){
                            this.highlightBoxes.get( this.highlightedActor ).appearance.material = this.invisibleMaterial;
                        }
                        box.appearance.material = this.boundingBoxMaterial;
                        this.highlightedActor = actor;
                        this.updateHanziInfoPanel(this.spawnedHanzi.get(box));
                    }else{
                        box.appearance.material = this.invisibleMaterial;
                        this.highlightedActor = null;
                    }
                }
            });
        }
    }

    private deleteItem(actor: MRE.Actor){
        let box = this.highlightBoxes.get(actor);
        box.unsubscribe('transform');

        this.spawnedHanzi.delete(box);
        actor.destroy();
        if (box !== undefined) { box.destroy(); }
    }

    private saveLevel(filename: string, user: MRE.User){
        let level: levelData = [];
        this.spawnedHanzi.forEach((v,k) => {
            level.push({
                char: v,
                transform: k.transform
            });
        });

        let filePath = `./public/levels/${path.basename(filename)}.json`;
        if (fs.existsSync(filePath)){
            user.prompt("File already exists, overwrite?").then((dialog) => {
                if (dialog.submitted) {
                    this.writeLevel(filePath, level, user);
                }
            });
        }
        else{
            this.writeLevel(filePath, level, user);
        }
    }

    private writeLevel(filePath: string, level: levelData, user: MRE.User){
        fs.writeFile(filePath, JSON.stringify(level), (err) => {
            if(err){ console.log(err); user.prompt("Failed")}
            else{ user.prompt("Saved"); }
        });
    }

    private async loadLevel(filename: string, user: MRE.User, editor: boolean = true){
        let relativePath = `levels/${filename}.json`
        if (!fs.existsSync(`./public/${relativePath}`)){
            user.prompt("No such file");
            return;
        }

        let filePath = `${this.baseUrl}/${relativePath}`;
        let level: levelData = await fetchJSON(filePath);
        level.forEach((d, _) => {
            this.spawnItem(d.char, d.transform, editor);
        });
    }

    private clearLevel(){
        this.highlightBoxes.forEach((_,k) => {
            this.deleteItem(k);
        })
    }
}
