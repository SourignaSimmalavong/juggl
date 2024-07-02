import {
  MetadataCache,
  Plugin, TFile, Vault, parseYaml, WorkspaceLeaf,
  TAbstractFile,
  TFolder,
} from 'obsidian';
import {
  type IJugglPluginSettings,
  JugglGraphSettingsTab,
  DefaultJugglSettings, LAYOUTS,
  genStyleGroups, emptyStyleGroup,
} from './settings';
import { Juggl } from './viz/visualization';
import { ImageServer } from './image-server';
import type {
  ICoreDataStore,
  IDataStore,
  IJugglStores,
  IJugglPlugin,
  IJuggl, IJugglSettings, IJugglEvents,
} from 'juggl-api';
import { OBSIDIAN_STORE_NAME, ObsidianStore } from './obsidian-store';
import cytoscape, { type CollectionArgument, type Core, type NodeCollection, type NodeSingular, type SingularElementArgument } from 'cytoscape';
import navigator from 'cytoscape-navigator';
import popper from 'cytoscape-popper';
import cola from 'cytoscape-cola';
import avsdf from 'cytoscape-avsdf';
import dagre from 'cytoscape-dagre';
import d3Force from 'cytoscape-d3-force';
import dblclick from 'cytoscape-dblclick';
import cxtmenu from 'cytoscape-cxtmenu';
import { addIcons } from './ui/icons';
import { STYLESHEET_PATH } from './viz/stylesheet';
import { JugglView } from './viz/juggl-view';
import { JugglNodesPane, JugglPane, JugglStylePane } from './pane/view';
import { WorkspaceManager } from './viz/workspaces/workspace-manager';
import { JUGGL_NODES_VIEW_TYPE, JUGGL_STYLE_VIEW_TYPE, JUGGL_VIEW_TYPE, VizId } from 'juggl-api';
import type { FSWatcher } from 'fs';
import { GlobalWarningModal } from './ui/settings/global-graph-modal';
import { getAPI, type Link } from "obsidian-dataview";


// I got this from https://github.com/SilentVoid13/Templater/blob/master/src/fuzzy_suggester.ts

// const STATUS_OFFLINE = 'Neo4j stream offline';


export default class JugglPlugin extends Plugin implements IJugglPlugin {
  // Match around [[ and ]], and ensure content isn't a wikilnk closure
  // This doesn't explicitly parse aliases.
  static CAT_DANGLING = 'dangling';

  settings: IJugglPluginSettings;
  path: string;
  // statusBar: HTMLElement;
  // neo4jStream: Neo4jStream;
  vault: Vault;
  metadata: MetadataCache
  coreStores: Record<string, ICoreDataStore> = {};
  stores: IDataStore[] = [];
  workspaceManager: WorkspaceManager;
  watcher: FSWatcher;
  ribbonIcon: HTMLElement;
  dirRibbonIcon: HTMLElement;
  eventHandlers: IJugglEvents[] = [];

  async onload(): Promise<void> {
    super.onload();
    console.log('Loading Juggl');
    navigator(cytoscape);
    cytoscape.use(popper);
    cytoscape.use(cola);
    cytoscape.use(dagre);
    cytoscape.use(avsdf);
    cytoscape.use(d3Force);
    cytoscape.use(dblclick);
    cytoscape.use(cxtmenu);

    addIcons();

    this.vault = this.app.vault;
    this.metadata = this.app.metadataCache;
    this.path = this.vault.getRoot().path;
    const obsidianStore = new ObsidianStore(this);
    this.addChild(obsidianStore);
    this.workspaceManager = new WorkspaceManager(this);
    this.addChild(this.workspaceManager);
    this.registerCoreStore(obsidianStore, OBSIDIAN_STORE_NAME);

    DefaultJugglSettings.globalStyleGroups = genStyleGroups(this);
    this.settings = Object.assign({}, DefaultJugglSettings, await this.loadData());
    this.settings.globalStyleGroups = this.settings.globalStyleGroups.map((g) =>
      Object.assign({}, emptyStyleGroup, g));
    this.settings.graphSettings = Object.assign({}, DefaultJugglSettings.graphSettings, this.settings.graphSettings);
    this.settings.embedSettings = Object.assign({}, DefaultJugglSettings.embedSettings, this.settings.embedSettings);

    this.registerHoverLinkSource("juggl-plugin", { 'display': "Juggl", defaultMod: true });


    this.addCommand({
      id: 'open-vis',
      name: 'Open local graph of note',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          return;
        }
        const name = file.name;
        this.openLocalGraph(name);
      },
    });
    this.addCommand({
      id: 'open-vis-dir',
      name: 'Open dir graph',
      callback: () => {
        this.openDirGraph();
      },
    });
    this.addCommand({
      id: 'open-vis-global',
      name: 'Open global graph',
      callback: () => {
        this.openGlobalGraph();
      },
    });

    this.addSettingTab(new JugglGraphSettingsTab(this.app, this));

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file: TFile) => {
      if (!file) {
        return;
      }
      menu.addItem((item) => {
        item.setTitle('Open Juggl').setIcon('dot-network')
          .onClick((evt) => {
            if (file.extension === 'md') {
              this.openLocalGraph(file.basename);
            } else {
              this.openLocalGraph(file.name);
            }
          });
      });
    }));


    this.registerMarkdownCodeBlockProcessor('juggl', async (src, el, context) => {
      // timeout is needed to ensure the div is added to the window. The graph will only load if
      // it is attached. This will also prevent any annoying hickups while looading the graph.
      setTimeout(async () => {
        const parsed = parseYaml(src);
        try {
          const settings = Object.assign({}, this.settings.embedSettings, parsed);
          if (!(LAYOUTS.contains(settings.layout))) {
            throw new Error(`Invalid layout. Choose one from ${LAYOUTS}`);
          }
          const stores: IJugglStores = {
            dataStores: [this.coreStores[settings.coreStore] as IDataStore].concat(this.stores),
            coreStore: this.coreStores[settings.coreStore],
          };
          el.style.width = settings.width;
          el.style.height = settings.height;
          if (Object.keys(parsed).contains('local')) {
            this.addChild(new Juggl(el, this, stores, settings, [parsed.local]));
          } else if (Object.keys(parsed).contains('workspace')) {
            const graph = new Juggl(el, this, stores, settings, undefined);
            if (!this.workspaceManager.graphs.contains(parsed.workspace)) {
              throw new Error('Did not recognize workspace. Did you misspell its name?');
            }
            this.addChild(graph);
            await this.workspaceManager.loadGraph(parsed.workspace, graph);
          } else if (Object.keys(parsed).contains('oql')) {
            // @ts-ignore
            if ('obsidian-query-language' in this.app.plugins.plugins) {
              // @ts-ignore
              const searchResults: IFuseFile[] = await this.app.plugins.plugins['obsidian-query-language'].search(parsed.oql);
              settings.expandInitial = false;
              this.addChild(new Juggl(el, this, stores, settings, searchResults.map((file) => file.title)));
            } else {
              throw new Error('The Obsidian Query Language plugin isn\'t loaded, so cannot query using oql!');
            }
          } else {
            throw new Error('Invalid query. Specify either the local property or the workspace property.');
          }
        } catch (error: any) {
          // taken from https://github.com/jplattel/obsidian-query-language/blob/main/src/renderer.ts
          const errorElement = activeDocument.createElement('div');
          errorElement.addClass('juggl-error');
          errorElement.innerText = error.message;
          el.appendChild(errorElement);
        }
      }, 200);
    });
    const plugin = this;

    // Adapted from https://github.com/liamcain/obsidian-calendar-plugin/blob/master/src/main.ts
    this.registerView(JUGGL_NODES_VIEW_TYPE, (leaf: WorkspaceLeaf) => new JugglNodesPane(leaf, plugin));
    this.registerView(JUGGL_STYLE_VIEW_TYPE, (leaf: WorkspaceLeaf) => new JugglStylePane(leaf, plugin));
    const createNodesPane = function () {
      if (plugin.app.workspace.getLeavesOfType(JUGGL_NODES_VIEW_TYPE).length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        leaf?.setViewState({ type: JUGGL_NODES_VIEW_TYPE });
      }//
    };
    const createStylePane = function () {
      if (plugin.app.workspace.getLeavesOfType(JUGGL_STYLE_VIEW_TYPE).length === 0) {
        const leaf = plugin.app.workspace.getRightLeaf(false);
        leaf?.setViewState({ type: JUGGL_STYLE_VIEW_TYPE });
      }
    };
    this.app.workspace.onLayoutReady(createNodesPane);
    this.app.workspace.onLayoutReady(createStylePane);

    this.addCommand({
      id: 'show-nodes-pane',
      name: 'Open Nodes Pane',
      checkCallback: (checking: boolean) => {
        if (checking) {
          return (
            this.app.workspace.getLeavesOfType(JUGGL_NODES_VIEW_TYPE).length === 0
          );
        }
        createNodesPane();
      },
    });
    this.addCommand({
      id: 'show-style-pane',
      name: 'Open Style Pane',
      checkCallback: (checking: boolean) => {
        if (checking) {
          return (
            this.app.workspace.getLeavesOfType(JUGGL_STYLE_VIEW_TYPE).length === 0
          );
        }
        createStylePane();
      },
    });


    const sheetPath = STYLESHEET_PATH(this.vault);
    // @ts-ignore
    this.registerEvent(this.vault.on('raw', (file) => {
      // @ts-ignore
      if (file === sheetPath) {
        console.log(`Updating stylesheet from ${sheetPath}`);
        for (const view of this.activeGraphs()) {
          view.updateStylesheet().then();
        }
      }
    }));
    this.setGlobalIcon();
    this.addChild(new ImageServer(this));


    // TODO: reenable events once I find a way not to refresh the nodes (and lose everything in the graph)
    //       when files are reindexed.
    // this.app.workspace.on('active-leaf-change', this.updateCurrentGlobal, this);

  }

  public setGlobalIcon() {
    if (this.ribbonIcon) {
      this.ribbonIcon.detach();
    }
    if (this.settings.globalGraphRibbon) {
      this.ribbonIcon = this.addRibbonIcon('ag-concentric', 'Juggl global graph', () => {
        this.openGlobalGraph();
      });
    }
  }

  public setDirIcon() {
    if (this.dirRibbonIcon) {
      this.dirRibbonIcon.detach();
    }
    if (this.settings.localGraphRibbon) {
      this.dirRibbonIcon = this.addRibbonIcon('cat', 'Juggl local graph', () => {
        this.openDirGraph();
      });
    }
  }

  public async openFileFromNode(node: NodeSingular, newLeaf = false): Promise<TFile> {
    const id = VizId.fromNode(node);
    if (!(id.storeId === 'core')) {
      return null;
    }
    let file = this.app.metadataCache.getFirstLinkpathDest(id.id, '');
    if (file) {
      await this.openFile(file);
    } else {
      // create dangling file
      // todo: add default folder
      const filename = id.id + '.md';
      file = await this.vault.create(filename, '');
      await this.openFile(file);
    }
    return file;
  }

  public async openFile(file: TFile, newLeaf = false) {
    await this.app.workspace.getLeaf(newLeaf).openFile(file);
  }

  async openLocalGraph(name: string) {
    const leaf = this.app.workspace.splitActiveLeaf(this.settings.splitDirection);
    // const query = this.localNeighborhoodCypher(name);
    const neovisView = new JugglView(leaf, this.settings.graphSettings, this, [name]);
    await leaf.open(neovisView);
  }

  async openGlobalGraph() {
    const leaf = this.app.workspace.getLeaf(false);
    // const query = this.localNeighborhoodCypher(name);
    const names = this.app.vault.getFiles().map((f) => f.extension === 'md' ? f.basename : f.name);
    if (names.length > 250) {
      const modal = new GlobalWarningModal(this.app, async () => {
        const neovisView = new JugglView(leaf, this.settings.globalGraphSettings, this, names);
        await leaf.open(neovisView);
        modal.close();
      });
      modal.open();
    } else {
      const neovisView = new JugglView(leaf, this.settings.globalGraphSettings, this, names);
      await leaf.open(neovisView);
    }
  }

  private getFilesFromDir(dir: TFolder): TFile[] {
    const elements: TAbstractFile[] = dir.children;
    const isDir = (element: TAbstractFile, index: number, array: TAbstractFile[]): boolean => {
      return element instanceof TFolder;
    };
    const isFile = (element: TAbstractFile, index: number, array: TAbstractFile[]): boolean => {
      return element instanceof TFile;
    };
    let queue: TFolder[] = elements.filter(isDir) as TFolder[];
    let files: TFile[] = elements.filter(isFile) as TFile[];
    while (queue.length) {
      const current_dir: TFolder = queue.pop() as TFolder;
      const current_elements: TAbstractFile[] = current_dir.children;
      const current_elements_dirs: TFolder[] = current_elements.filter(isDir) as TFolder[];
      const current_elements_files: TFile[] = current_elements.filter(isFile) as TFile[];

      files.push(...current_elements_files);
      queue.push(...current_elements_dirs);
    }

    return files;
  }

  private async getGlobal(file: TFile): Promise<TFile | null> {
    let global_parent_str = `Global/${file.parent?.path}`;
    let global_filepath: string = `${global_parent_str}/Global ${file.basename}.md`;
    let global_parent = this.app.vault.getFolderByPath(global_parent_str);
    if (!global_parent) {
      this.app.vault.createFolder("/" + global_parent_str);
    }
    let global_file: TAbstractFile | null = this.app.vault.getAbstractFileByPath(global_filepath);
    if (!global_file) {
      global_file = await this.app.vault.create(global_filepath, "") as TFile;
      console.log(`Created global file: ${global_file.path}`);

      // @ts-ignore
      const mm = this.app.plugins.plugins["metadata-menu"].api;

      let success = await mm.postNamedFieldsValues_synced(global_file, [{ name: "fileClass", payload: { value: "Global" } }]);
      if (!success) {
        console.log("Failure postNamedFieldsValues_synced");
        return null;
      }

      await mm.insertMissingFields(global_file, -1, false, false, "Global", undefined, true);
    }

    console.log(`Get global file: ${global_file.path}`);

    return global_file as TFile;
  }

  private async updateCurrentGlobal(currentGlobal: TFile) { //  leaf: WorkspaceLeaf | null) {
    // // console.log("this", this);
    // if (!leaf) {
    //   return;
    // }

    // let jugglView = leaf.view;
    // if (!(jugglView instanceof JugglView)) {
    //   console.log("not a JugglView");
    //   return;
    // }

    // Apply the current global file path to the super-global file.
    let superGlobal = await this.app.vault.getFileByPath("Global.md");
    if (!superGlobal) {
      console.log("Could not load Global.md");
      return;
    }

    // if (!jugglView.juggl) {
    //   console.log("juggl is null");
    //   return;
    // }
    // let currentGlobal: TFile | null = jugglView.juggl.globalFile;

    // if (!currentGlobal) {
    //   console.log("No global file for current JugglView. Should not happen!");
    //   return;
    // }

    // @ts-ignore
    const mm = this.app.plugins.plugins["metadata-menu"].api;

    const success = await mm.postNamedFieldsValues_synced(superGlobal,
      [
        {
          name: "CurrentGlobal",
          payload:
          {
            value: "[[" + currentGlobal.path + "]]"
          }
        }
      ]);
    if (success) {
      console.log(`Updated current global to ${currentGlobal.path}`);
    }
    else {
      console.log(`Failed to update current global to ${currentGlobal.path}`);
    }
  }

  async openDirGraph() {
    // const query = this.localNeighborhoodCypher(name);
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      return;
    }
    const folder: TFolder | null = file.parent;
    if (!folder) {
      return;
    }

    const files: TFile[] = this.getFilesFromDir(folder);

    // Opening the tab takes time. Do it first and then update the formulas.
    // Display the graph in the background (takes time)
    const names = files.map((f) => f.extension === 'md' ? f.basename : f.name);
    const leaf: WorkspaceLeaf = this.app.workspace.splitActiveLeaf(this.settings.splitDirection); //this.app.workspace.getLeaf(true);
    const neovisView = new JugglView(leaf, this.settings.dirGraphSettings, this, names);
    console.log("Created neovisView");

    let juggl = neovisView.juggl;
    // TODO: reenable events once I find a way not to refresh the nodes (and lose everything in the graph)
    //       when files are reindexed.
    // juggl.events.on('expand', async (nodes: NodeCollection) => { this.updateVizFiles(nodes, false); });
    // juggl.events.on('hide', async (nodes: NodeCollection) => { this.updateVizFiles(nodes, false); });
    // juggl.events.on('vizReady', async () => { this.updateVizFiles(cytoscape().collection(), true); });
    // juggl.events.on('elementsChange', async () => { console.log("baouuuuuuuuuuuuuuu!") });
    console.log("Added juggl viz events");

    // Update the formulas.

    // @ts-ignore
    const mm = this.app.plugins.plugins["metadata-menu"].api;
    // @ts-ignore
    const dv = this.app.plugins.plugins["dataview"].api;

    let global_file: TFile | null = await this.getGlobal(file);
    if (!global_file) {
      console.log(`Could not create global file for "${file.path}"`);
      return;
    }

    // Save the global file for later updates.
    juggl.globalFile = global_file;

    // Refresh the Global Dynamic dir with the parent dir of current file.
    let context_payload_orig_list = await mm.getValues(global_file, "Context");
    if (context_payload_orig_list.length == 0) {
      console.log("context_payload_orig_list is empty");
      return;
    }
    let context_payload_orig = context_payload_orig_list[0];
    if (!context_payload_orig) {
      console.log('Cannot get value "Context". Using default');
      context_payload_orig = {
        DynamicDir: "",
        StaticDirs: ["Medecine Chinoise/tableaux pathologiques/symptômes",
          "Physiology",
          "Temporality",
          "Anatomy"
        ],
        VizFiles: []
      };
    }

    // console.log("context_payload_orig", context_payload_orig);
    // console.log("context_payload_orig dyn dir", context_payload_orig[0]["DynamicDir"]);
    let context_payload = {
      value: context_payload_orig
    };
    context_payload.value["DynamicDir"] = folder.path;

    let success = await mm.postNamedFieldsValues_synced(global_file, [
      { name: "Context", payload: context_payload },
    ]);
    console.log("DONE Context");

    if (!success) {
      console.log("Failure postNamedFieldsValues_synced");
      return;
    }

    // Context Files is composed of files within the Context Dir 
    // (i.e. files next to current file and in sub-directories)
    await mm.updateSingleFormula({ file: global_file, fieldName: "ContextDirFiles" });
    await mm.applyUpdates();
    console.log("DONE Formulas");

    // Context Files should also include the files within the Global Static Folders.
    const static_dirs: string[] = context_payload_orig["StaticDirs"];
    console.log("static_dirs", static_dirs);
    let static_files: TFile[] = [];
    for (let static_dir of static_dirs) {
      const current_dir: TFolder = this.app.vault.getFolderByPath(static_dir) as TFolder;
      let current_static_files: TFile[] = this.getFilesFromDir(current_dir);
      console.log(current_dir.path, current_static_files);
      static_files.push(...current_static_files);
    }

    let files_neighborhood: string[] = [];
    for (let file of files) {
      if (file.extension != '.md') {
        continue;
      }
      let outlinks = dv.page(file.path).file.outlinks.values.map((v: Link) => v.path);
      files_neighborhood = files_neighborhood.concat(outlinks);
      let inlinks = dv.page(file.path).file.inlinks.values.map((v: Link) => v.path);
      files_neighborhood = files_neighborhood.concat(inlinks);
    }
    let files_neighborhood_set: Set<string> = new Set(files_neighborhood);
    files_neighborhood = [...files_neighborhood_set.values()];
    static_files = [...new Set(static_files).values()].filter((f) => files_neighborhood.includes(f.path));
    console.log("static_files (neighborhood)", static_files);

    // Make sure there is no duplicates.
    let files_and_static_set: Set<TFile> = new Set(files.concat(static_files));
    let files_and_static: TFile[] = [...files_and_static_set.values()]
    console.log("files_and_static", files_and_static);

    // Update the other files in the Context Dirs (both dynamic and static).
    // InLinks and OutLinks are independant.
    // Update all these formulas in parallel.
    await Promise.all(files_and_static.map((file: TFile) => new Promise(res => {
      return Promise.all([
        mm.updateSingleFormula({ file: file, fieldName: "InLinks" }),
        mm.updateSingleFormula({ file: file, fieldName: "OutLinks" }),
      ]).then(res);
    })));
    console.log("DONE single formulas");
    await mm.applyUpdates();
    console.log("DONE Formulas others");

    // await mm.unlock();

    // // Display the graph in the background (takes time)
    // const names = files.map((f) => f.extension === 'md' ? f.basename : f.name);
    // const leaf = this.app.workspace.getLeaf(true);
    // const neovisView = new JugglView(leaf, this.settings.dirGraphSettings, this, names);
    // console.log("Created neovisView");


    // Note: Use local mode (workspace is buggy). Expand and hide events is too slow to update nodes in real time
    // let juggl = neovisView.juggl;
    juggl.events.on('expand', async (nodes: NodeCollection) => { this.updateVizFiles(nodes, false, null); });
    juggl.events.on('hide', async (nodes: NodeCollection) => { this.updateVizFiles(nodes, false, null); });
    // // juggl.events.on('elementsChange', async () => { this.updateVizFiles(); });
    juggl.events.on('vizReady', async () => { this.updateVizFiles(cytoscape().collection(), true, neovisView); });
    console.log("Added juggl viz events");


    await leaf.open(neovisView);
    console.log("Opened neovisView");

  }

  private async updateVizFiles(expandedNodes: NodeCollection, force: boolean = false, neovisView: JugglView | null) {
    // @ts-ignore
    const mm = this.app.plugins.plugins["metadata-menu"].api;

    console.log("updateVizFiles");
    console.log("expandedNodes", expandedNodes);

    if (!neovisView) {
      neovisView = this.app.workspace.getActiveViewOfType(JugglView);
      if (neovisView == null) {
        console.log("Cannot find JugglView (viz not ready yet)");
        return;
      }
    }
    let global_file: TFile | null = neovisView.juggl.globalFile; //this.app.vault.getAbstractFileByPath("Global.md") as TFile;

    if (!global_file) {
      console.log(`Cannot access global file`);
      return;
    }

    expandedNodes = expandedNodes.filter((node: NodeSingular) => {
      const id: VizId = VizId.fromNode(node);
      if (id.storeId === 'core') {
        const file: TFile | null = this.metadata.getFirstLinkpathDest(id.id, '');
        if (file) {
          return !file.name.startsWith("Global ") && file.name != "Global.md";
        }
      }
      return true;
    });

    // const expandedIds = expandedNodes.map((n) => VizId.fromNode(n));
    if (expandedNodes.length == 0 && !force) {
      return;
    }
    
    // Get the global Context
    let context_payload_orig_list = await mm.getValues(global_file, "Context");
    if (context_payload_orig_list.length == 0) {
      console.log("[updateVizFiles] context_payload_orig_list is empty");
      return;
    }

    let context_payload_orig = context_payload_orig_list[0];

    // Refresh the VizFiles (visible nodes)
    const nodes: NodeCollection = neovisView.juggl.viz.nodes();
    const visible_nodes: NodeCollection = nodes.filter((node: NodeSingular, i: number, eles: CollectionArgument) => {
      return node.visible();
    });
    const visible_nodes_paths: string[] = visible_nodes.map((node: NodeSingular, i: number, eles: CollectionArgument) => {
      const id: VizId = VizId.fromNode(node);
      if (id.storeId === 'core') {
        const file: TFile | null = this.metadata.getFirstLinkpathDest(id.id, '');
        if (file) {
          return file.path;
        }
      }
      return "";
    }).filter((path: string) => path != "");

    console.log("visible_nodes_paths", visible_nodes_paths);

    let context_payload = {
      value: context_payload_orig
    };
    context_payload.value["VizFiles"] = visible_nodes_paths.join(", ");

    let success = await mm.postNamedFieldsValues_synced(global_file, [
      { name: "Context", payload: context_payload },
    ]);
    if (!success) {
      console.log("[updateVizFiles] Failure postNamedFieldsValues_synced");
      // await mm.unlock();
      return;
    }

    // The VizInLinksCount and VizOutLinksCount formulas rely on the super global file (Global.md).
    // Need to refresh the path to the current global.
    this.updateCurrentGlobal(global_file);

    // Update the VizInLinksCount and VizOutLinksCount of all the VizFiles.
    let visible_nodes_files: (TFile | null)[] = visible_nodes_paths.map((path: string) => {
      const file = this.app.vault.getFileByPath(path);
      if (!file) {
        console.log(`Cannot open file ${path}`);
        return null;
      }
      return file;
    });
    let visible_nodes_files_sure: TFile[] = visible_nodes_files.filter((file: TFile | null) => file) as TFile[];
    await Promise.all(visible_nodes_files_sure.map((file: TFile) => new Promise(res => {
      return Promise.all([
        mm.updateSingleFormula({ file: file, fieldName: "VizInLinksCount" }),
        mm.updateSingleFormula({ file: file, fieldName: "VizOutLinksCount" }),
      ]).then(res);
    })));
    await mm.applyUpdates();
    console.log("Finished updating viz links count");
  }

  public activeGraphs(): IJuggl[] {
    // TODO: This is not a great method, no way to find back the inline graphs!
    return this.app.workspace
      .getLeavesOfType(JUGGL_VIEW_TYPE)
      .map((l) => (l.view as JugglView).juggl) as IJuggl[];
  }

  async onunload() {
    super.onunload();
    console.log('Unloading Juggl');
    this.app.workspace.detachLeavesOfType(JUGGL_NODES_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(JUGGL_STYLE_VIEW_TYPE);
    if (this.watcher) {
      this.watcher.close();
    }
  }

  public registerStore(store: IDataStore) {
    this.stores.push(store);
  }

  public removeStore(store: IDataStore): void {
    this.stores.remove(store);
  }

  public registerCoreStore(store: ICoreDataStore, name: string) {
    if (!(store.storeId() === 'core')) {
      throw new Error('Can only register IDataStores as core if their storeId is core');
    }
    this.coreStores[name] = store;
  }

  public createJuggl(el: HTMLElement, settings?: IJugglSettings, datastores?: IJugglStores, initialNodes?: string[]): IJuggl {
    // Public constructor for Juggl instances. Used for the API.
    if (!settings) {
      settings = Object.assign({}, DefaultJugglSettings.embedSettings);
      if (initialNodes) {
        settings.expandInitial = false;
      }
    }
    if (!datastores) {
      datastores = this.defaultStores();
    }
    return new Juggl(el, this, datastores, settings, initialNodes);
  }

  public defaultStores(): IJugglStores {
    return {
      dataStores: [this.coreStores[OBSIDIAN_STORE_NAME] as IDataStore].concat(this.stores),
      coreStore: this.coreStores[OBSIDIAN_STORE_NAME],
    };
  }

  registerEvents(handler: IJugglEvents) {
    this.eventHandlers.push(handler);
  }

  removeEvents(handler: IJugglEvents) {
    this.eventHandlers.remove(handler);
  }
}
