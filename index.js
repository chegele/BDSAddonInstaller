
import path from 'path';
import admZip from 'adm-zip';
import fs from 'fs-extra';
import Logger from 'chegs-simple-logger';

let log = new Logger({});
log.logGeneral = true;
log.logError = true;
log.logWarning = true;
log.logDetail = false;
log.logDebug = false;


// Below variables are updated by the constructor.
// All paths will be converted to full paths by including serverPath at the beginning.
let serverPath = null;
let worldName = null;

let addonPath = 'BDS-Addons/';

let serverPacksJsonPath = 'valid_known_packs.json';
let serverPacksJSON = null;
let serverResourcesDir = 'resource_packs/';
let serverBehaviorsDir = 'behavior_packs/';

let worldResourcesJsonPath = 'worlds/<worldname>/world_resource_packs.json';
let worldResourcesJSON = null;
let worldBehaviorsJsonPath = 'worlds/<worldname>/world_behavior_packs.json';
let worldBehaviorsJSON = null;
let worldResourcesDir = 'worlds/<worldname>/resource_packs/';
let worldBehaviorsDir = 'worlds/<worldname>/behavior_packs/';

// Below variables updated by mapInstalledPacks function.
// Updated to contain installed pack info {name, uuid, version, location}
let installedServerResources = new Map();
let installedServerBehaviors = new Map();
let installedWorldResources = new Map();
let installedWorldBehaviors = new Map();

// These files will be validated to confirm the provided serverPath is accurate.
const requiredFiles = ['behavior_packs', 'resource_packs', 'valid_known_packs.json'];

export default class BDSAddonInstaller {

    /**
     * Prepares to install addons for the provided Bedrock Dedicated Server.
     * @param {String} providedServerPath - The path to the root directory of the Bedrock Dedicated Server. 
     * @param {Boolean} verboseMode - Optional parameter for enabling additional logging. 
     */
    constructor(providedServerPath, verboseMode) {
        // If verboseMode update logging
        if (verboseMode) {
            log.logDetail = true;
            log.logDebug = true;
        }

        // Validate server path (path is provided, path is valid, path contains required files)
        if (!providedServerPath) throw new Error('You must provide a server path for BDSAddonInstaller');
        if (!fs.existsSync(providedServerPath)) throw new Error('The provided server path does not exist.\n' + providedServerPath);
        requiredFiles.forEach(file => {
            let filePath = path.join(providedServerPath, file);
            if (!fs.existsSync(filePath)) throw new Error('Unable to find server files in provided path.\n' + filePath);
        });

        // Update all module paths from relative to full paths.
        serverPath = providedServerPath;
        addonPath = path.join(providedServerPath, addonPath);
        worldName = readWorldName();
        worldResourcesJsonPath = path.join(serverPath, worldResourcesJsonPath.replace('<worldname>', worldName));
        worldBehaviorsJsonPath = path.join(serverPath, worldBehaviorsJsonPath.replace('<worldname>', worldName));
        worldResourcesDir = path.join(serverPath, worldResourcesDir.replace('<worldname>', worldName));
        worldBehaviorsDir = path.join(serverPath, worldBehaviorsDir.replace('<worldname>', worldName));
        serverPacksJsonPath = path.join(serverPath, serverPacksJsonPath);
        serverResourcesDir = path.join(serverPath, serverResourcesDir);
        serverBehaviorsDir = path.join(serverPath, serverBehaviorsDir); 

        // Create JSON files if they do not exists
        fs.ensureFileSync(serverPacksJsonPath);
        fs.ensureFileSync(worldResourcesJsonPath);
        fs.ensureFileSync(worldBehaviorsJsonPath);
        
        // Read installed packs from JSON files & attempt to parse content.
        let serverPackContents = fs.readFileSync(serverPacksJsonPath);
        let worldResourceContents = fs.readFileSync(worldResourcesJsonPath);
        let worldBehaviorContents = fs.readFileSync(worldBehaviorsJsonPath);
        // If there is an error parsing JSON assume no packs installed and use empty array.
        try { serverPacksJSON = JSON.parse(serverPackContents) } catch(err) { serverPacksJSON = [] };
        try { worldResourcesJSON = JSON.parse(worldResourceContents) } catch(err) { worldResourcesJSON = [] };
        try { worldBehaviorsJSON = JSON.parse(worldBehaviorContents) } catch(err) { worldBehaviorsJSON = [] };
        // If unexpected results from parsing JSON assume no packs installed and use empty array.
        if (!Array.isArray(serverPacksJSON)) serverPacksJSON = [];
        if (!Array.isArray(worldResourcesJSON)) worldResourcesJSON = [];
        if (!Array.isArray(worldBehaviorsJSON)) worldBehaviorsJSON = [];

        // Map installed packs from install directories
        installedServerResources = mapInstalledPacks(serverResourcesDir);
        installedServerBehaviors = mapInstalledPacks(serverBehaviorsDir);
        installedWorldResources = mapInstalledPacks(worldResourcesDir);
        installedWorldBehaviors = mapInstalledPacks(worldBehaviorsDir);
    }

    /**
     * Installs the provide addon/pack to the BDS server and the active world. 
     * @param {String} packPath - The full path to the mcpack or mcaddon file. 
     */
    async installAddon(packPath) {

        // Validate provided pack (pack exists & is the correct file type)
        if (!await fs.exists(packPath)) throw new Error('Unable to install pack. The provided path does not exist. ' + packPath);
        if (!packPath.endsWith('.mcpack') && !packPath.endsWith('.mcaddon')) throw new Error('Unable to install pack. The provided file is not an addon or pack. ' + packPath);
        if (packPath.endsWith('.mcaddon')) {
            // If the provided pack is an addon extract packs and execute this function again for each one. 
            let packs = await extractAddonPacks(packPath);
            for (const pack of packs) await this.installAddon(pack);
            return;
        }
        
        // Gather pack details from the manifest.json file
        let manifest = await extractPackManifest(packPath);
        let name = manifest.header.name.replace(/\W/g, '');
        let uuid = manifest.header.uuid;
        let version = manifest.header.version;
        if (!version) version = manifest.header.modules[0].version;
        let type;
        if (manifest.modules) {
            type = manifest.modules[0].type.toLowerCase();
        } else if (manifest.header.modules) {
            type = manifest.header.modules[0].type.toLowerCase();
        }else {
            throw new Error('Unable to install pack. Unknown pack manifest format.\n' + packPath);
        }

        log.general('BDSAddonInstaller - Installing ' + name + '...');

        // Check if already installed
        let installedWorldPack, installedServerPack = null;
        if (type == 'resources') {
            installedWorldPack = installedWorldResources.get(uuid);
            installedServerPack = installedServerResources.get(uuid);
        }else if (type == 'data') {
            installedWorldPack = installedWorldBehaviors.get(uuid);
            installedServerPack = installedServerBehaviors.get(uuid)
        }

        // Check if current installed packs are up to date
        if (installedWorldPack || installedServerPack) {
            let upToDate = true;
            if (installedWorldPack && installedWorldPack.version.toString() != version.toString()) upToDate = false;
            if (installedServerPack && installedServerPack.version.toString() != version.toString()) upToDate = false;
            if (upToDate) {
                log.general(`BDSAddonInstaller - The ${name} pack is already installed and up to date.`);
                return;
            }else{
                // uninstall pack if not up to date
                log.detail('BDSAddonInstaller - Uninstalling old version of pack');
                if (installedServerPack) await uninstallServerPack(uuid, installedServerPack.location);
                if (installedWorldPack && type == 'resources') await uninstallWorldResource(uuid, installedWorldPack.location);
                if (installedWorldPack && type == 'data') await uninstallWorldBehavior(uuid, installedWorldPack.location);
            }
        }

        await installPack(packPath, manifest);
        log.general('BDSAddonInstaller - Successfully installed the ' + name + ' pack.');

    }

    /**
     * Installs all of the addons & packs found within the BDS-Addons directory.
     * @param {Boolean} removeOldPacks - Remove all currently installed packs?
     * NOTE: Running this function with remove packs is only recommended if facing issues.
     */
    async installAllAddons(removeOldPacks) {
        // If chosen, uninstall all world packs.
        if (removeOldPacks) await uninstallAllWorldPacks();

        // Read all packs & addons from BDS-Addon directory.
        let packs = await fs.readdir(addonPath);

        // Get the full path of each addon/pack and install it. 
        for (let pack of packs) {
            try {
                let location = path.join(addonPath, pack);
                await this.installAddon(location);
            }catch(err) {
                log.error('BDSAddonInstaller - ' + err);
            }
        }
    }

    /**
     * Updates the simple logger to use the provided configuration. 
     * Reference the readme for configuration options.
     * https://github.com/chegele/Logger
     * @param {Logger.Options} logConfig - An object with the logging configuration
     */
    setLogConfig(logConfig) {
        log = new Logger(logConfig);
    }
}

////////////////////////////////////////////////////////////////
// BDSAddonInstaller - Install & Uninstall functions

/**
 * Installs the provided pack to the world and Bedrock Dedicated Server.
 * @param {String} packPath - The path to the pack to be installed.
 * @param {Object} manifest - The pre-parsed manifest information for the pack. 
 */
async function installPack(packPath, manifest) {
    // Extract manifest information
    let name = manifest.header.name.replace(/\W/g, '');
    let uuid = manifest.header.uuid;
    let version = manifest.header.version;
    if (!version) version = manifest.header.modules[0].version;
    let type;
    if (manifest.modules) {
        type = manifest.modules[0].type.toLowerCase();
    } else if (manifest.header.modules) {
        type = manifest.header.modules[0].type.toLowerCase();
    }else {
        throw new Error('Unable to install pack. Unknown pack manifest format.\n' + packPath);
    }

    // Create placeholder variables for pack installation paths. 
    let installServerPath, installWorldPath, WorldPacksJSON, WorldPacksPath, rawPath = null;

    // Update variables based on the pack type.
    if (type == 'data') {
        installServerPath = path.join(serverBehaviorsDir, name);
        installWorldPath = path.join(worldBehaviorsDir, name);
        WorldPacksJSON = worldBehaviorsJSON;
        WorldPacksPath = worldBehaviorsJsonPath;
        rawPath = 'behavior_packs/' + name;
    }else if (type == 'resources') {
        installServerPath = path.join(serverResourcesDir, name);
        installWorldPath = path.join(worldResourcesDir, name);
        WorldPacksJSON = worldResourcesJSON;
        WorldPacksPath = worldResourcesJsonPath;
        rawPath = 'resource_packs/' + name;
    }else {
        throw new Error('Unknown pack type, ' + type);
    }
    
    // Install pack to the world.
    let worldPackInfo = {'pack_id': uuid, "version": version}
    WorldPacksJSON.unshift(worldPackInfo);
    await promiseExtract(packPath, installWorldPath);
    await fs.writeFile(WorldPacksPath, JSON.stringify(WorldPacksJSON, undefined, 2));
    
    // Install pack to the server.
    version = `${version[0]}.${version[1]}.${version[2]}`;
    let serverPackInfo = {"file_system": "RawPath", "path": rawPath, "uuid": uuid, "version": version};
    serverPacksJSON.splice(1, 0, serverPackInfo);
    await promiseExtract(packPath, installServerPath);
    await fs.writeFile(serverPacksJsonPath, JSON.stringify(serverPacksJSON, undefined, 2));
}

/**
 * Uninstall all resource and behavior packs from the Minecraft world.
 * If the server also has the pick it will also be uninstalled.
 * NOTE: Vanilla packs can't be safely removed from the server packs & there is no way to differentiate vanilla and added packs.
 * NOTE: This is why only packs found installed to the world will be removed from the server.  
 */
async function uninstallAllWorldPacks() {
    log.general('BDSAddonInstaller - Uninstalling all packs found saved to world.');
    
    // Uninstall all cached world resource packs.
    for (let pack of installedWorldResources.values()) {
        await uninstallWorldResource(pack.uuid, pack.location);
        let serverPack = installedServerResources.get(pack.uuid);
        if (serverPack) await uninstallServerPack(pack.uuid, serverPack.location);
    }

    // Uninstall all cached world behavior packs.
    for (let pack of installedWorldBehaviors.values()) {
        await uninstallWorldBehavior(pack.uuid, pack.location);
        let serverPack = installedServerBehaviors.get(pack.uuid);
        if (serverPack) await uninstallServerPack(pack.uuid, serverPack.location);
    }

    // All packs are cached by the constructor.
    // Reload world packs after uninstall. 
    installedServerResources = mapInstalledPacks(serverResourcesDir);
    installedServerBehaviors = mapInstalledPacks(serverBehaviorsDir);
    installedWorldResources = mapInstalledPacks(worldResourcesDir);
    installedWorldBehaviors = mapInstalledPacks(worldBehaviorsDir);
}

// TODO: uninstallWorldResource, uninstallWorldBehavior, and uninstallServerPack share the same logic. 
// These functions can be merged into one function using an additional argument for pack type. 

/**
 * Uninstalls the pack from the world_resource_packs.json by uuid & deletes the provided pack path. 
 * @param {String} uuid - The id of the pack to remove from the world_resource_packs.json file. 
 * @param {String} location - The path to the root directory of the installed pack to be deleted.
 * WARNING: No validation is done to confirm that the provided path is a pack. 
 */
async function uninstallWorldResource(uuid, location) {
    // Locate the pack in the manifest data.
    let packIndex = findIndexOf(worldResourcesJSON, 'pack_id', uuid);

    // Remove the pack data and update the json file.
    if (packIndex != -1) {
        worldResourcesJSON.splice(packIndex, 1);
        await fs.writeFile(worldResourcesJsonPath, JSON.stringify(worldResourcesJSON, undefined, 2));
        log.detail(`BDSAddonInstaller - Removed ${uuid} from world resource packs JSON.`);
    }

    // Delete the provided pack path.
    if (await fs.exists(location)) {
        await fs.remove(location);
        log.detail(`BDSAddonInstaller - Removed ${location}`);
    }
}

/**
 * Uninstalls the pack from the world_behavior_packs.json by uuid & deletes the provided pack path. 
 * @param {String} uuid - The id of the pack to remove from the world_behavior_packs.json file. 
 * @param {String} location - The path to the root directory of the installed pack to be deleted.
 * WARNING: No validation is done to confirm that the provided path is a pack. 
 */
async function uninstallWorldBehavior(uuid, location) {
    // Locate the pack in the manifest data.
    let packIndex = findIndexOf(worldBehaviorsJSON, 'pack_id', uuid);

    // Remove the pack data and update the json file.
    if (packIndex != -1) {
        worldBehaviorsJSON.splice(packIndex, 1);
        await fs.writeFile(worldBehaviorsJsonPath, JSON.stringify(worldBehaviorsJSON, undefined, 2));
        log.detail(`BDSAddonInstaller - Removed ${uuid} from world behavior packs JSON.`);
    }

    // Delete the provided pack path.
    if (await fs.exists(location)) {
        await fs.remove(location);
        log.detail(`BDSAddonInstaller - Removed ${location}`);
    }
}

/**
 * Uninstalls the pack from the valid_known_packs.json by uuid & deletes the provided pack path. 
 * @param {String} uuid - The id of the pack to remove from the valid_known_packs.json file. 
 * @param {String} location - The path to the root directory of the installed pack to be deleted.
 * WARNING: No validation is done to confirm that the provided path is a pack.  
 */
async function uninstallServerPack (uuid, location) {
    // Locate the pack in the manifest data.
    let packIndex = findIndexOf(serverPacksJSON, 'uuid', uuid);

    // Remove the pack data and update the json file.
    if (packIndex != -1) {
        serverPacksJSON.splice(packIndex, 1);
        await fs.writeFile(serverPacksJsonPath, JSON.stringify(serverPacksJSON, undefined, 2));
        log.detail(`BDSAddonInstaller - Removed ${uuid} from server packs JSON.`);
    }

    // Delete the provided pack path. 
    if (await fs.exists(location)) {
        await fs.remove(location);
        log.detail(`BDSAddonInstaller - Removed ${location}`);
    }
}

///////////////////////////////////////////////////////////
// BDSAddonInstaller misc functions

/**
 * Extracts bundled packs from the provided addon file.
 * This will only need to be ran once on an addon as it will convert the addon to multiple .mcpack files. 
 * @param {String} addonPath - The path of the addon file to extract packs from.
 */
async function extractAddonPacks(addonPath) {
    // Validate the provided path is to an addon.
    if (!await fs.exists(addonPath)) throw new Error('Unable to extract packs from addon. Invalid file path provided: ' + addonPath);
    if (!addonPath.endsWith('.mcaddon')) throw new Error('Unable to extract packs from addon. The provided file is not an addon. ' + addonPath);
    log.detail('BDSAddonInstaller - Extracting packs from ' + addonPath);

    // Extract file path and name info for saving the extracted packs. 
    let addonName = path.basename(addonPath).replace('.mcaddon', '');
    let dirPath = path.dirname(addonPath);

    // Create a temp location and extract the addon contents to it.
    let tempLocation = path.join(dirPath, 'tmp/', addonName + '/');
    await promiseExtract(addonPath, tempLocation);
    let packs = fs.readdirSync(tempLocation);
    let results = [];

    // Move addon packs from temporary location to BDS-Addon directory.
    for (let pack of packs) {
        log.detail(`BDSAddonInstaller - Extracting ${pack} from ${addonName}.`);

        // If the mcpack is already packaged, move the file. 
        if (pack.endsWith('.mcpack')) {
            let packName = addonName + '_' + pack;
            let packFile = path.join(tempLocation, pack);
            let packDestination = path.join(dirPath, packName);
            await fs.move(packFile, packDestination);
            results.push(packDestination);
            log.detail('BDSAddonInstaller - Extracted ' + packDestination);
        }else {
            // The pack still needs to be zipped and then moved.
            let packName = addonName + '_' + pack + '.mcpack';
            let packFolder = path.join(tempLocation, pack);
            let packDestination = path.join(dirPath, packName);
            await promiseZip(packFolder, packDestination);
            results.push(packDestination);
            log.detail('BDSAddonInstaller - Extracted ' + packDestination);
        }
    }

    // Remove temporary files and old addon.
    await fs.remove(path.join(dirPath, 'tmp/'));;
    await fs.unlink(addonPath);

    // Return an array of paths to the extracted packs.
    return results;
}

/**
 * Extracts the manifest data as an object from the provided .mcpack file.
 * @param {String} packPath - The path to the pack to extract the manifest from.
 * @returns {Object} The parsed manifest.json file.
 */
function extractPackManifest(packPath) {
    // Validate the provided pack (path exists and file is correct type)
    if (!fs.existsSync(packPath)) throw new Error('Unable to extract manifest file. Invalid file path provided: ' + packPath);
    if (!packPath.endsWith('.mcpack')) throw new Error('Unable to extract manifest file. The provided file is not a pack. ' + packPath);
    log.detail('BDSAddonInstaller - Reading manifest data from ' + packPath);

    // Locate the manifest file in the zipped pack.
    let archive = new admZip(packPath);
    let manifest = archive.getEntries().filter(entry => entry.entryName.endsWith('manifest.json') || entry.entryName.endsWith('pack_manifest.json'));
    if (!manifest[0]) throw new Error('Unable to extract manifest file. It does not exist in this pack. ' + packPath);
    
    // Read the manifest and return the parsed JSON.
    return JSON.parse(archive.readAsText(manifest[0].entryName));
}


/**
 * Reads the world name from a BDS server.properties file.
 * @returns {String} The value found for level-name from server.properties.
 * NOTE: This function is Synchronous for use in the constructor without need for a callback.
 */
function readWorldName() {
    let propertyFile = path.join(serverPath, 'server.properties');
    log.detail('BDSAddonInstaller - Reading world name from ' + propertyFile);
    if (!fs.existsSync(propertyFile)) throw new Error('Unable to locate server properties @ ' + propertyFile);
    let properties = fs.readFileSync(propertyFile);
    let levelName = properties.toString().match(/level-name=.*/);
    if (!levelName) throw new Error('Unable to retrieve level-name from server properties.');
    return levelName.toString().replace('level-name=', '');
}

/**
 * Collects manifest information from all installed packs in provided location.
 * @param {String} directory - The path to the directory containing extracted/installed packs.
 * @returns {Map<PackData>} A collection of manifest information with the uuid as the key.
 * 
 * Bug Note:
 * Some of the vanilla packs are installed multiple times using the same uuid but different versions.
 * This causes the map to only capture the last read pack with that uuid.
 * This bug should not impact the installer, as there wont be a need to install / update vanilla packs. 
 * 
 * NOTE: This function is Synchronous for use in the constructor without need for a callback.
 */

function mapInstalledPacks(directory) {
    // The provided directory may not exist if the world has no packs installed.
    // Create the results Map & return empty if the directory does not exist.
    let results = new Map();
    if (!fs.pathExistsSync(directory)) return results;

    // Extract manifest & path information for each installed pack
    let subdirectories = fs.readdirSync(directory);
    subdirectories.forEach(subdirectory => {
        let location = path.join(directory, subdirectory);
        log.detail('BDSAddonInstaller - Reading manifest data from ' + location);

        // Locate the directory containing the pack manifest.
        let manifestLocation = findFilesSync(['manifest.json', 'pack_manifest.json'], location);
        if (!manifestLocation) {
            log.error(manifestLocation);
            log.warning('BDSAddonInstaller - Unable to locate manifest file of installed pack.');
            log.warning('BDSAddonInstaller - Installed location: ' + location);
            return;
        }

        // Check if pack is using a manifest.json or pack.manifest.json
        let filePath = path.join(manifestLocation, 'manifest.json');
        if (!fs.existsSync(filePath)) filePath = path.join(manifestLocation, 'pack_manifest.json');
        let file = fs.readFileSync(filePath);

        // Some vanilla packs have comments in them, this is not valid JSON and needs to be removed.
        file = file.toString().replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m);
        let manifest = JSON.parse(file);

        // Collect and map the manifest information
        let uuid = manifest.header.uuid;
        let name = manifest.header.name;
        let version = manifest.header.version;
        if (!version) version = manifest.header.modules[0].version;
        results.set(uuid, {name, uuid, version, location}); 
    });
    return results;
}

////////////////////////////////////////////////////////////////////
// Misc helper functions

/**
 * Finds the first index of a key value pair from an array of objects. 
 * @param {Object[]} objectArray - An array of objects to search. 
 * @param {String} key - The key to match the value against.
 * @param {*} value - The value to find the index of. 
 * @returns {Number} - The index of the key value pair or -1. 
 */
function findIndexOf(objectArray, key, value) {
    for (let index = 0; index < objectArray.length; index++) {
        if (objectArray[index][key] == value) return index;
    }
    return -1;
}

/**
 * Extracts all of the contents from a provided .zip archive. 
 * @param {String} file - The file to extract the contents from.
 * @param {String} destination - The directory to unzip the contents into. 
 */
function promiseExtract(file, destination) {
    return new Promise(function(resolve, reject) {
        let archive = new admZip(file);
        archive.extractAllToAsync(destination, true, err => {
            if (err) return reject(err);
            resolve();
        });
    });
}

/**
 * Compresses contents of the provided folder using ADM Zip.
 * @param {String} folder - The folder containing folder containing the files to compress. 
 * @param {String} destinationFile - The file to save the archive as.  
 */
function promiseZip(folder, destinationFile) {
    return new Promise(async function(resolve, reject) {
        let archive = new admZip();
        let contents = await fs.readdir(folder);
        for (let file of contents) {
            let filePath = path.join(folder, file);
            let stat = await fs.stat(filePath);
            stat.isFile() ? archive.addLocalFile(filePath) : archive.addLocalFolder(filePath, file);
        }
        archive.writeZip(destinationFile, err => {
            if (err) return reject(err);
            resolve();
        });
    });
}

/**
 * Attempt to locate the subdirectory containing one of the provided file names. 
 * @param {String[]} filenames - The name of files to search for.
 * @param {String} directory - The directory to search in.
 * @returns {String} The path to the first folder containing one of the files or null.
 */
function findFilesSync(filenames, directory) {

    // Get the contents of the directory and see if it includes one of the files.
    const contents = fs.readdirSync(directory);
    for (let file of contents) {
        if (filenames.includes(file)) return directory;
    }

    // If unable to find one of the files, check subdirectories. 
    for (let subDir of contents) {
        let dirPath = path.join(directory, subDir);
        let stat = fs.statSync(dirPath);
        if (stat.isDirectory()) {
            let subDirectoryResult = findFilesSync(filenames, dirPath);
            if (subDirectoryResult) return subDirectoryResult;
        }
    }

    // Unable to find the files. 
    return null;
}


//TODO: Add type definitions for the manifest files. 

/**
 * @typedef {Object} PackData - Information extracted from an installed pack.
 * @property {String} name - The name found in the packs manifest.json file.
 * @property {String} uuid - The uuid found in the packs manifest.json file.
 * @property {String} version - the version found in the packs manifest.json fle.
 * @property {String} location - The full path to the root directory of the installed pack. 
 * Used by the mapInstalledPacks function
 */