#!/usr/bin/env node

import BDSAddonInstaller from './index.js';
import path from 'path';
import fs from 'fs-extra';

let args = process.argv.slice(2);
const cwd = process.cwd();

const addonDirectory = 'BDS-Addons';
const requiredFiles = ['behavior_packs', 'resource_packs', 'valid_known_packs.json'];
const useExample = ' bds-addon-installer <pathToServer> \n Example: bds-addon-installer "C:\\Program Files\\BedrockServer\\" \n';

console.log('\nRunning Bedrock Dedicated Server Addon Installer...');

// Check if the user has added the -r option. This is for removing old addons before installing the new addons.
let removeOldPacks = false;
if (args.includes('-r')) removeOldPacks = true;

// Check if the user has added the -v option. This is for enabling verbose mode.
let verboseMode = false;
if (args.includes('-v')) verboseMode = true;

// Remove options from the argument array
args = args.filter(arg => arg != '-r' && arg != '-v');

// If multiple arguments provided cancel execution. There may be a space in the path provided but no quotes.
if (args.length > 1) { 
    console.log('You provided too many arguments. Maybe you forgot to add "quotes" around your path?');
    console.log(useExample);;
    process.exit();
}

// If no arguments provided, assume current working directory is server location.
if (args.length == 0) args.push(cwd);
let serverPath = args[0];

// Check if user is asking for help
if (['help', '-h', '-H', '--help'].includes(serverPath)) {
    console.log(useExample);
    process.exit();
}

// Check if provided path is relative path & convert to absolute path if needed. 
if (!serverPath.startsWith(cwd)) serverPath = path.join(cwd, serverPath);

// Validate provided path exists
if (!fs.existsSync(serverPath)) {
    console.log('The provided path does not exist...');
    console.log('path: ' + serverPath);;
    process.exit();
}

// Validate that provided path contains bedrock server files
requiredFiles.forEach(file => {
    let filePath = path.join(serverPath, file);
    if (!fs.existsSync(filePath)) {
        console.log('Required files/folders are missing. Please provide a path to the root of a Bedrock Server.');
        console.log('Missing file: ' + file);
        console.log('Provided path: ' + serverPath);
        process.exit();
    }
});

// Check if addon directory exists & create it if not.
const addonPath = path.join(serverPath, addonDirectory);
if (!fs.existsSync(addonPath)) {
    fs.mkdirSync(addonPath);
    console.log('It looks like this may be your first time using bds-addon-installer.');
    console.log('Place all of you your packs in the addon folder and run the script again.');;
    console.log('Addon Location: ' + addonPath);
    process.exit();
}

// Install the addons.
const installer = new BDSAddonInstaller(serverPath, verboseMode);
installer.installAllAddons(removeOldPacks)
