/**
 * Auto Build Marlin
 *
 * abm.js
 *
 * Build Tool methods. Config Tool can be separate.
 * 
 */

// Extend builtins
String.prototype.lpad = function(len, chr) {
  if (chr === undefined) { chr = '&nbsp;'; }
  var s = this+'', need = len - s.length;
  if (need > 0) { s = new Array(need+1).join(chr) + s; }
  return s;
};

String.prototype.dequote = function()        { return this.replace(/"([^"]*)"/g, '$1'); };
String.prototype.prePad = function(len, chr) { return len ? this.lpad(len, chr) : this; };
String.prototype.zeroPad = function(len)     { return this.prePad(len, '0'); };
String.prototype.toHTML = function()         { return jQuery('<div>').text(this).html(); };
String.prototype.regEsc = function()         { return this.replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&"); }
String.prototype.lineCount = function(ind)   { var len = (ind === undefined ? this : this.substr(0,ind*1)).split(/\r?\n|\r/).length; return len > 0 ? len - 1 : 0; };
String.prototype.lines = function()          { return this.split(/\r?\n|\r/); };
String.prototype.line = function(num)        { var arr = this.split(/\r?\n|\r/); return num < arr.length ? arr[1*num] : ''; };
String.prototype.replaceLine = function(num,txt) { var arr = this.split(/\r?\n|\r/); if (num < arr.length) { arr[num] = txt; return arr.join('\n'); } else return this; }
String.prototype.toLabel = function()        { return this.replace(/[\[\]]/g, '').replace(/_/g, ' ').toTitleCase(); }
String.prototype.toTitleCase = function()    { return this.replace(/([A-Z])(\w+)/gi, function(m,p1,p2) { return p1.toUpperCase() + p2.toLowerCase(); }); }
Number.prototype.limit = function(m1, m2)  {
  if (m2 == null) return this > m1 ? m1 : this;
  return this < m1 ? m1 : this > m2 ? m2 : this;
};
Date.prototype.fileStamp = function(filename) {
  var fs = this.getFullYear()
    + ((this.getMonth()+1)+'').zeroPad(2)
    + (this.getDate()+'').zeroPad(2)
    + (this.getHours()+'').zeroPad(2)
    + (this.getMinutes()+'').zeroPad(2)
    + (this.getSeconds()+'').zeroPad(2);

  if (filename !== undefined)
    return filename.replace(/^(.+)(\.\w+)$/g, '$1-['+fs+']$2');

  return fs;
}

// Marlin files that provide context for
// the current build. All these are read
// at startup. However currently only the
// config files are watched for changes.
var mfiles = {
  pins:       { name: 'pins.h',              path: ['src', 'pins'] },
  boards:     { name: 'boards.h',            path: ['src', 'core'] },
  config:     { name: 'Configuration.h',     path: []              },
  config_adv: { name: 'Configuration_adv.h', path: []              },
  version:    { name: 'Version.h',           path: ['src', 'inc']  }
};

const nicer = {
  build: 'build',
  upload: 'upload',
  traceback: 'upload (traceback)',
  clean: 'clean',
};

const path = require('path'),
        fs = require('fs'),
        os = require('os');

var info = {},              // For general data without declaring

    boards_text = '',       // Contents of boards.h for parsing
    pins_text = '',         // Contents of pins.h for parsing
    config_text = '',       // Contents of Configuration.h for parsing
    config_adv_text = '';   // Contents of Configuration_adv.h for parsing

var context, vscode, vc, ws, vw, abm_path, project_path, pv;

function init(c, v) {
  context = c;
  vscode = v;
  vc = v.commands;
  ws = v.workspace;
  vw = v.window;
  abm_path = path.join(c.extensionPath, 'abm');
  project_path = ws.workspaceFolders[0].uri.fsPath;
}

var define_list = [[],[]],  // arrays with all define names
    define_occur = [{},{}], // lines where defines occur in each file
    define_section = {};    // the section of each define

function updateDefineList(cindex, txt) {
  var section = 'hidden',
      leave_out_defines = ['CONFIGURATION_H', 'CONFIGURATION_H_VERSION', 'CONFIGURATION_ADV_H', 'CONFIGURATION_ADV_H_VERSION'],
      define_more = {},
      occ_list = {},
      findDef = new RegExp('^.*(@section|#define)\\s+(\\w+).*$', 'gm');
  // scan for sections and defines
  var r;
  while((r = findDef.exec(txt)) !== null) {
    var name = r[2];
    if (r[1] == '@section') {
      section = name;
    }
    else if (!leave_out_defines.includes(name)) {                 // skip some defines
      var lineNum = txt.lineCount(r.index),                       // the line number
          inst = { cindex:cindex, lineNum:lineNum, line:r[0] },   // config, line, section/define
          in_sect = (name in define_more);                        // already found (locally)?

      if (!in_sect) occ_list[name] = [ inst ];                    // no, first item in section

      if (!in_sect && !(name in define_section)) {                // first time in section, ever
        define_more[name] = section; // new first-time define
      }
      else {
        occ_list[name].push(inst);                                // it's another occurrence
      }
    }
  }
  define_list[cindex] = Object.keys(define_more);
  define_occur[cindex] = occ_list;
  define_section = Object.assign({}, define_section, define_more);
}

// TODO: Use previously parsed config data for speed

function _confEnabled(text, optname) {
  const find = new RegExp(`^\\s*#define\\s+${optname}\\b`, 'gm'),
        r = find.exec(text);
  if (0) console.log(`${optname} is ${r?'ENABLED':'unset'}`);
  return (r !== null); // Any match means it's uncommented
}

function confEnabled(fileid, optname) { return _confEnabled(mfiles[fileid].text, optname); }
function configEnabled(optname)       { return confEnabled('config',     optname); }
function configAdvEnabled(optname)    { return confEnabled('config_adv', optname); }
function configAnyEnabled(optname) {
  return configEnabled(optname) ? true : configAdvEnabled(optname);
}

// Get a single config value
function _confValue(text, optname) {
  const find = new RegExp(`^\\s*#define\\s+${optname}\\s+(.+)(\\s+//.+$)?`, 'gm'),
        r = find.exec(text);
  return (r !== null) ? r[1] : '';
}

// Get a single config value
function confValue(fileid, optname) { return _confValue(mfiles[fileid].text, optname); }
function configValue(optname)       { return confValue('config',     optname); }
function configAdvValue(optname)    { return confValue('config_adv', optname); }
function configAnyValue(optname) {
  return configEnabled(optname) ? configValue(optname) : configAdvValue(optname);
}

//
// Get the path to a Marlin file
//
function _marlinFilePath(f) {
  if (!f.fullpath) {
    let p = '';
    f.path.forEach((v) => { p = path.join(p, v); });
    f.fullpath = path.join(project_path, 'Marlin', p, f.name);
  }
  return f.fullpath;
}

function marlinFilePath(fileid) { return _marlinFilePath(mfiles[fileid]); }

function envBuildPath(env, file) {
  var bp = path.join(project_path, '.pio', 'build', env);
  if (file !== undefined) bp = path.join(bp, file);
  return bp;
}

function existingBuildPath(env) {
  var bp = envBuildPath(env);
  return fs.existsSync(bp) ? bp : null;
}

//
// Watch Configuration*.h files for changes and refresh the view
// The fs.watch event is fast and usually sends several events.
// So instead of calling refreshNewData directly, put it on a timeout.
//

var timeouts = [];
function onConfigFileChanged(e, fname) {
  if (0) console.log('File changed:', e, fname);
  if (timeouts[fname] !== undefined) clearTimeout(timeouts[fname]);
  timeouts[fname] = setTimeout(() => {
    timeouts[fname] = undefined;
    refreshNewData();
  }, 2000);
}

var watchers = [];
function unwatchConfigurations() {
  watchers.forEach((w) => { w.close() });
  watchers = [];
}

function watchConfigurations() {
  watchers = [
    fs.watch(marlinFilePath('config'), {}, onConfigFileChanged),
    fs.watch(marlinFilePath('config_adv'), {}, onConfigFileChanged)
  ];
}

//
// An Environment can be in one of these states:
//  - Does not exist. No Clean option.
//  - Exists and has completed build. Show a Clean option.   .exists
//  - Exists and has incomplete build. Show a Clean option.  .exists.incomplete
//  - Does not exist but build started. Hide all buttons.    .busy
//  - Exists and build is underway. Hide all buttons.        .exists.busy
//
// The strategy is to watch the build folder for changes up to the
// state where the build is underway and the env folder exists.
//
// After that the IPC file signals when the build is done.
//

var build = { watcher:null, env:null, active:false };
function currentBuildEnv() {
  return build.active ? build.env : '(none)';
}

//
// Stop watching the build folder
//
function unwatchBuildFolder() {
  if (build.watcher) {
    if (0) console.log(`Stop Watching Build: ${currentBuildEnv()}.`);
    build.watcher.close();
    build.watcher = null;
  }
  if (build.env)
    refreshBuildStatus(build.env);
}

//
// Watch the build folder for changes in *any* contents.
// As long as contents are changing, a build is occurring.
// Use the cancel-restart method to keep putting off the UI
// update. Only the last timeouts will actually occur.
//
function watchBuildFolder(env) {
  if (!build.watcher) {
    const bp = existingBuildPath(env);
    if (bp) {
      build.watcher = fs.watch(bp, {}, (e,f) => { onBuildFolderChanged(e,f,env); });
      if (0) console.log("Watching Build...");
    }
    else {
      // Build folder doesn't exist (yet)
      // Keep looking for it for several seconds
      if (0) console.log("No build folder yet. Trying in 2s...");
      setTimeout(()=>{ watchBuildFolder(env); }, 2000);
    }
  }
}

var refresh_to = [];
function cancelBuildRefresh() {
  refresh_to.forEach(clearTimeout);
  refresh_to = [];
}

function buildIsFinished(reason) {
  if (0) console.log(`buildIsFinished (${reason}): ${currentBuildEnv()}`);

  // Updating now so kill timers
  cancelBuildRefresh();

  // Stop watching the build folder for changes.
  // If build.env is set it will also update the UI.
  build.active = false;
  unwatchBuildFolder();

  // Clear the environment
  build.env = null;
}

function onIPCFileChange() {
  buildIsFinished('IPC File Change');  // Assume the build is completed. TODO: Verify contents of the IPC file.
}

function onBuildFolderChanged(e, fname, env) {
  cancelBuildRefresh();

  if (fname == 'firmware.hex' || fname == 'firmware.bin') {
    // If the firmware file changed, assume the build is done now
    refresh_to = [ setTimeout(()=>{ unwatchBuildFolder(); }, 500) ];
    if (0) console.log(`onBuildFolderChanged (bin/hex): ${env}`);
  }
  else {
    refresh_to = [
      // Set timeouts that assume lots of changes are underway
      setTimeout(()=>{ refreshBuildStatus(env); }, 500),
      // Assume nothing will pause for more than 15 seconds
      setTimeout(()=>{ unwatchBuildFolder(); }, 15000)
    ];
    if (0) console.log(`onBuildFolderChanged: ${env}`);
  }
}

//
// Get the type of geometry and stuff like that
//
var machine_info;
function getMachineSettings() {
  var out = {};

  out.name = configValue('CUSTOM_MACHINE_NAME').dequote();

  const mtypes = [ 'DELTA', 'MORGAN_SCARA', 'COREXY', 'COREXZ', 'COREYZ', 'COREYX', 'COREZX', 'COREZY' ],
       mpretty = [ 'Delta', 'SCARA', 'CoreXY', 'CoreXZ', 'CoreYZ', 'CoreYX', 'CoreZX', 'CoreZY' ];

  let s = 'Cartesian';
  mtypes.every((v,i) => {
    if (!configEnabled(v)) return true;
    s = mpretty[i]; return false;
  });
  out.style = s;

  let d = out.dimensions = { x: configValue('X_BED_SIZE'), y: configValue('Y_BED_SIZE'), z: configValue('Z_MAX_POS') };

  out.description = `${s} ${d.x}x${d.y}x${d.z}mm`;

  const bed_sensor = configValue('TEMP_SENSOR_BED');
  out.heated_bed = !!(1 * bed_sensor);
  if (out.heated_bed) {
    out.bed_sensor = bed_sensor;
    out.description += ` with Heated Bed (${bed_sensor})`;
  }
  else
    out.description += ' (no Heated Bed)';

  machine_info = out;
  return machine_info;
}

//
// Extract temperature sensor options from Configuration.h
//
var temp_sensor_arr;
function extractTempSensors() {
  var out = [];

  //pv.postMessage({ command:'text', text:mfiles.config.text });

  // Get all the thermistors and save them into an object
  const findAll = new RegExp('(\\/\\*+[\\s\\S]+\\*\\/)\\s*#define\\s+TEMP_SENSOR_0', 'g'),
        r = findAll.exec(mfiles.config.text);
  const findEach = new RegExp('^\\s*\\*\\s*(-?\\d+)\\s*:\\s*(.+)$', 'gm');
  let s;
  while (s = findEach.exec(r[1])) out[s[1]] = { desc: s[2] };

  temp_sensor_arr = out;
  return temp_sensor_arr;
}

//
// Get the number of EXTRUDERS and related options
//
var extruder_info;
function getExtruderSettings() {
  var out = {};
  const extruders = configValue('EXTRUDERS') * 1;

  out.extruders = extruders;
  out.diam = configValue('DEFAULT_NOMINAL_FILAMENT_DIA');

  // Get the extruder temp sensors
  out.sensors = [];
  for (let i = 0; i < extruders; i++)
    if (!(out.sensors[i] = configValue(`TEMP_SENSOR_${i}`)))
      out.sensor_err = true;

  if (extruders == 1 && configEnabled('TEMP_SENSOR_1_AS_REDUNDANT'))
    out.sensors[1] = configValue('TEMP_SENSOR_1');

  // Only one of these types is allowed at a time
  const etypes = [ 'SINGLENOZZLE',                           // Single nozzle, multiple steppers
                   'DUAL_X_CARRIAGE',                        // IDEX: single, duplication or mirror
                   'PARKING_EXTRUDER',                       // Parkable, with solenoid
                   'MAGNETIC_PARKING_EXTRUDER',              // Parkable, with magnet
                   'SWITCHING_TOOLHEAD',                     // Switching with servo
                   'MAGNETIC_SWITCHING_TOOLHEAD',            // Switching with magnet
                   'ELECTROMAGNETIC_SWITCHING_TOOLHEAD' ];
       epretty = [ 'Single Nozzle' ];
  etypes.every((v,i) => {
    if (!configEnabled(v)) return true;
    out.type = epretty[i] ? epretty[i] : v.toLabel(); return false;
  });

  // These are mutually-exclusive
  const efancy = [ 'MIXING_EXTRUDER', 'SWITCHING_EXTRUDER', 'SWITCHING_NOZZLE', 'MK2_MULTIPLEXER', 'PRUSA_MMU2' ];
  efancy.every((v) => {
    if (!configEnabled(v)) return true;
    out.fancy = v.toLabel(); return false;
  });

  if (out.fancy) {
    let e = extruders;
    if (out.fancy == 'Mixing Extruder')
      e = out.steppers = configValue('MIXING_STEPPERS');
    out.fancy += ` (${e} channels)`;
  }

  if (!out.type && !out.fancy) {
    switch (out.extruders) {
      case 1: out.description = '(Single Extruder)'; break;
      case 2: out.description = '(Dual Extruder)'; break;
      default: out.description = out.extruders + ' Extruders'; break;
    }
  }
  else {
    if (out.type && out.fancy)
      out.description = `${out.type} with ${out.fancy}`;
    else if (out.type == 'Single Nozzle')
      out.description = `Single Nozzle with ${out.extruders} inputs`;
    else if (out.type)
      out.description = `${out.type} with ${out.extruders}`;
    else
      out.description = out.fancy;
  }

  extruder_info = out;
  return extruder_info;
}

//
// Get information from the board's pins file(s)
//
var pindef_info;
function getPinDefinitionInfo() {
  if (!mfiles.pindef) {
    const pbits = `src/pins/${board_info.pins_file}`.split('/');
    mfiles.pindef = { name: pbits.pop(), path: pbits };
    processMarlinFile('pindef');
  }

  pindef_info = {
    board_name: confValue('pindef', 'BOARD_INFO_NAME').dequote()
  };

  return pindef_info;
}

//
// - Get Marlin version and distribution date
//
var version_info;
function extractVersionInfo() {
  var out = {
    vers: _confValue(mfiles.version.text, 'SHORT_BUILD_VERSION').dequote(),
    date: _confValue(mfiles.version.text, 'STRING_DISTRIBUTION_DATE').dequote()
  };
  version_info = out;
  return version_info;
}

//
// - Get pins file, archs, and envs for a board
//   from the pins.h file.
// - Get the status of all environment builds.
//
var board_info;
function extractBoardInfo(board) {
  var r, out = {}, sb = board.replace('BOARD_', '');

  // Get the include line matching the board
  const lfind = new RegExp(`if\\s*MB\\(${sb}\\).*\n\\s*(#include.+)\n`, 'g');
  if ((r = lfind.exec(mfiles.pins.text))) {

    let inc_line = r[1];

    out.pins_file = inc_line.replace(/.*#include\s+"([^"]*)".*/, '$1');

    out.archs = inc_line.replace(/.+\/\/\s*((\w+,?\s*)+)\s*env:.+/, '$1');
    out.archs_arr = out.archs.replace(',',' ').replace(/\s+/,' ').split(' ');

    out.envs = [];
    var efind = new RegExp('env:(\\w+)', 'g');
    while ((r = efind.exec(inc_line)))
      out.envs.push({ name: r[1] });
  }

  // Get the description from the boards.h file
  var cfind = new RegExp(`#define\\s+${board}\\s+\\d+\\s*//(.+)`, 'gm');
  r = cfind.exec(mfiles.boards.text);
  out.description = r ? r[1].trim() : '';

  board_info = out;
  return board_info;
}

//
// Process data now that all files are loaded
//
//  - Read values from the config files
//  - Update the UI with initial values
//
function allFilesAreLoaded() {

  // Send text for display in the view
  //pv.postMessage({ command:'text', text:mfiles.boards.text });

  const mb = configValue('MOTHERBOARD');

  if (mb !== undefined) {

    const sensors = extractTempSensors();

    const version_info = extractVersionInfo();
    if (0) console.log("Version Info : ", version_info);
    const board_info = extractBoardInfo(mb);
    if (0) console.log("Board Info : ", board_info);
    const machine_info = getMachineSettings();
    if (0) console.log("Machine Info : ", machine_info);
    const extruder_info = getExtruderSettings();
    if (0) console.log("Extruder Info : ", extruder_info);
    const pindef_info = getPinDefinitionInfo();
    if (0) console.log("Pin Defs Info : ", pindef_info);

    // If no CUSTOM_MACHINE_NAME was set, get it from the pins file
    if (!machine_info.name) {
      let def = confValue('pindef', 'DEFAULT_MACHINE_NAME');
      if (!def || def == 'BOARD_INFO_NAME')
        def = pindef_info.board_name;
      machine_info.name = def ? def.dequote() : '3D Printer';
    }

    const d = new Date(version_info.date);

    postValue('vers', `${version_info.vers}`);
    postValue('date', d.toLocaleDateString([], { weekday:'long', year:'numeric', month:'short', day:'numeric' }));

    postValue('extruders', extruder_info.extruders);
    postValue('extruder-desc', extruder_info.description);

    postValue('machine', machine_info.name);
    postValue('machine-desc', machine_info.description);

    postValue('board', mb.replace('BOARD_', '').replace(/_/g, ' '));
    postValue('board-desc', board_info.description);

    postValue('pins', board_info.pins_file);
    if (pindef_info.board_name) postValue('pins-desc', pindef_info.board_name);

    postValue('archs', board_info.archs);

    refreshBuildStatus();
  }

  updateDefineList(0, mfiles.config.text);

  watchConfigurations();
  runSelectedAction();
}

function refreshOldData() { allFilesAreLoaded(); }

function readFileError(err, msg) {
  if (0) console.log("fs.readFile err: ", err);
  pv.postMessage({ command:'error', error:msg, data:err });
}

//
// Read a workspace file
// If it's the last file, go on to extract data and update the UI.
//
function processMarlinFile(fileid) {

  const mf_path = marlinFilePath(fileid);

  if (0) console.log(`Processing... ${mf_path}`);

  if (info.filesToLoad) {
    fs.readFile(mf_path, (err, data) => {
      if (err)
        readFileError(err, `Couldn't read ${mfiles[fileid].name}`);
      else {
        mfiles[fileid].text = data.toString();
        if (--info.filesToLoad == 0) allFilesAreLoaded();
      }
    });
  }
  else {
    try {
      // Use node.js to read the file
      //var data = fs.readFileSync(mf_path);
      mfiles[fileid].text = fs.readFileSync(mf_path, {encoding:'utf8'});
    } catch (err) {
      readFileError(err, `Couldn't read ${mfiles[fileid].name}`);
    }
  }
}

//
// Verify that one of Marlin's files exists
//
function marlinFileCheck(fileid) {
  var file_issue;
  try {
    fs.accessSync(marlinFilePath(fileid), fs.constants.F_OK | fs.constants.W_OK);
  } catch (err) {
    file_issue = err.code === 'ENOENT' ? 'is missing' : 'is read-only';
  }
  return file_issue;
}

//
// Reload files and refresh the UI
//
function refreshNewData() {
  var is_marlin = true, files = [];

  for (const k in mfiles) {
    const err = marlinFileCheck(k);
    if (err) {
      postError(`Error: ${mfiles[k].name} ${err}.`);
      is_marlin = false;
      break;
    }
    files.push(k);
  }

  if (is_marlin) {
    info.filesToLoad = files.length;
    files.forEach(processMarlinFile);
  }
  else
    postError('Please open Marlin in the workspace.');
}

//
// Get information about the last (or current) build
//  - exists, completed, busy, stamp
//
function lastBuild(env) {
  var bp = envBuildPath(env),
      out = {
        exists: fs.existsSync(bp),
        completed: false,
        busy: build.active && build.env == env,
        stamp: ''
      };

  if (out.exists) {

    // Get the built binary path, if any
    out.completed = true;
    let tp = envBuildPath(env, 'firmware.bin');
    if (!fs.existsSync(tp)) {
      tp = envBuildPath(env, 'firmware.hex');
      if (!fs.existsSync(tp)) {
        out.completed = false;
        tp = bp;
      }
    }

    let stat = fs.lstatSync(tp),
           d = new Date(stat.mtime),
        locd = d.toLocaleDateString([], { weekday:'long', year:'numeric', month:'short', day:'numeric' }),
        loct = d.toLocaleTimeString([], { timeStyle:'medium' });

    out.stamp = `at ${loct} on ${locd}`;
  }
  return out;
}

//
// - Refresh the build status for one or more environments.
// - Send the envs data to the UI for display.
//
function refreshBuildStatus(env) {
  if (0) console.log(`Refreshing Build: ${currentBuildEnv()}`);
  board_info.envs.forEach((v) => {
    if (!env || v.name == env) {
      let b = lastBuild(v.name);
      v.exists    = b.exists;
      v.completed = b.completed;
      v.stamp     = b.stamp;
      v.busy      = b.busy;
    }
  });
  let m = { command:'envs', val:board_info.envs };
  if (0) console.log("Posting:", m);
  pv.postMessage(m);
}

//
// An IPC file for message passing from the Terminal
// This is watched for a command during a build.
// The IPC file is deleted after reading, or when the Terminal or View close.
// (The extension could cancel the Terminal when closing for simplicity,
//  or it could look for a build in progress.)
// It's preferred to put it into the TMP folder, if standard
//
const ipc_file = path.join(os.tmpdir(), 'ipc');
var ipc_watcher;
function createIPCFile() {
  fs.writeFile(ipc_file, 'ipc', (err) => {
    if (!err) {
      if (0) console.log('IPC file created.');
      ipc_watcher = fs.watch(ipc_file, {}, () => { onIPCFileChange(); });
    }
    else
      if (0) console.log('IPC file existed?');
  });
}

function destroyIPCFile() {
  ipc_watcher.close();
  ipc_watcher = null;
  fs.unlink(ipc_file, (err) => {
    if (0) {
      if (err)
        console.log("IPC Delete Error:", err);
      else
        console.log("IPC file deleted.", err);
    }
  });
}

//
// Open a Terminal if needed.
// When the Terminal closes, abort the build and update the UI.
// Send a command to the Terminal
//
var terminal, NEXT_TERM_ID = 1;
function terminal_command(ttl, cmdline) {
  // Get config options with the 'auto-build' prefix
  const abm_config = ws.getConfiguration('auto-build', true),
        reuse_terminal = abm_config.get('reuseTerminal');

  if (!terminal || !reuse_terminal) {
    var title;
    if (reuse_terminal)
      title = 'Marlin Auto Build';
    else {
      title = `Marlin ${ttl.toTitleCase()} (${NEXT_TERM_ID})`;
      NEXT_TERM_ID++;
    }
    terminal = vw.createTerminal({ name:title, env:process.env });
    vw.onDidCloseTerminal((t) => {
      if (t === terminal) {
        terminal = null;
        buildIsFinished('Closed Terminal');
        setTimeout(refreshBuildStatus, 200);
      }
    });
  }
  else
    if (0) console.log("Terminal PID is " + terminal.processId);

  terminal.show(true);

  if (process.platform == 'win32') {
    terminal.sendText(cmdline);
    terminal.sendText(`echo "done" >${ipc_file}`);
  }
  else
    terminal.sendText(cmdline + ` ; echo "done" >${ipc_file}`);
}

//
// Start a PlatformIO command, update the UI, and watch the build.
//
function pio_command(opname, env, nosave) {

  if (build.active) {
    postError(`A build (${build.env}) is already underway.`);
    return;
  }

  let args;
  switch (opname) {
    case 'build':     args = 'run';                 break;
    case 'clean':     args = 'run --target clean';  break;
    case 'upload':    args = 'run --target upload'; break;
    case 'traceback': args = 'run --target upload'; break;
    default:
      vw.showErrorMessage('Unknown action: "' + opname + '"');
      return;
  }
  if (!nosave) vc.executeCommand('workbench.action.files.saveAll');
  terminal_command(opname, `platformio ${args} -e ${env}`);

  // Show the build as 'busy'
  build.env = env;
  build.active = true;
  refreshBuildStatus(env);

  // Start watching the build folder.
  // (Will wait until the folder gets created.)
  if (opname != 'clean') watchBuildFolder(env);
}

function postError(err, data) {
  pv.postMessage({ command:'error', error:err, data:data });
}

function postWIP() {
  postError('Configuration Tool Under Construction');
}

// Post a value to the UI
function postValue(tag, val) {
  var message = { command:'set', tag:tag, val:val };
  if (0) console.log("Send to UI", message);
  pv.postMessage(message);
}

function subpath(sub, filename) {
  var uri = abm_path;
  if (sub !== '') uri = path.join(uri, sub);
  if (filename !== undefined) uri = path.join(uri, filename);
  return pv.asWebviewUri(vscode.Uri.file(uri));
}

function img_path(filename) { return subpath('img', filename); }
function js_path(filename) { return subpath('js', filename); }
function css_path(filename) { return subpath('css', filename); }

// Contents of the Web View
function homeContent() {
  var jquery_js = js_path('jquery-3.3.1.min.js'),
      abm_js = js_path('webview.js'),
      abm_css = css_path('webview.css'),
      marlin_svg = css_path('marlin.svg'),
      abm_icon = img_path('abm-tools-70.png'),
      btn_build = img_path('btn-build.svg'),
      btn_upload = img_path('btn-upload.svg'),
      btn_debug = img_path('btn-debug.svg'),
      btn_clean = img_path('btn-clean.svg'),
      btn_config = img_path('btn-config.svg'),
      btn_refresh = img_path('btn-refresh.svg'),
      tool_build = img_path('tool-build.svg'),
      tool_config = img_path('tool-config.svg'),
      social_mf = img_path('abm-tools-32.png'),
      social_gh = img_path('social-gh.svg'),
      social_tw = img_path('social-tw.svg'),
      social_fb = img_path('social-fb.svg'),
      social_yt = img_path('social-yt.svg')
      ;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auto Build Marlin — Home</title>
<link href="https://fonts.googleapis.com/css?family=Fira+Mono&amp;subset=latin,latin-ext" rel="stylesheet" type="text/css" />
<style>
  * { --marlin-svg: url(${marlin_svg}); }
</style>
<script>
//<![CDATA[

  const vscode = acquireVsCodeApi();

  function msg(obj) {
    if (obj.command == 'tool') {
      $('.abm-panel').hide();
      $(\`#abm-\${obj.tool}\`).show();
      $('#abm-toolbar button').removeClass();
      $(\`#btn-\${obj.tool}\`).addClass('active');
    }
    vscode.postMessage(obj);
  }

// ]]>
</script>
<script src="${jquery_js}"></script>
<script src="${abm_js}"></script>
<link rel="stylesheet" href="${abm_css}" type="text/css" media="all" />
</head>
<body>
<div id="abm-layout">
<div id="abm-toolbar">
  <a id="abm-icon" onclick="msg({ command:'refresh' })"><img src="${abm_icon}" width="32" /></a>
  <button id="btn-build" type="button" onclick="msg({ command:'tool', tool:'build' })"><img src="${tool_build}" /><span>Build</span></button>
  <button id="btn-config" type="button" onclick="msg({ command:'tool', tool:'config' })"><img src="${tool_config}" /><span>Configure</span></button>
</div>
<div id="abm-build" class="abm-panel">
  <div id="abm-top">
    <button type="button" onclick="msg({ command:'refresh' })"><img src="${btn_refresh}" /> Refresh</button>
  </div>
  <h1><a href="https://marlinfw.org">Marlin Firmware</a> <span>Auto Build</span></h1>
  <div id="abm-main">
    <table id="info">
      <tr><th>Firmware:</th>      <td><div>Marlin <span id="info-vers"></span></div><div id="info-date" class="abm-caption"></div></td></tr>
      <tr><th>Machine Name:</th>  <td><div id="info-machine"></div><div id="info-machine-desc" class="abm-caption"></div></td></tr>
      <tr><th>Extruders:</th>     <td><div id="info-extruders"></div><div id="info-extruder-desc" class="abm-caption"></div></td></tr>
      <tr><th>Board:</th>         <td><div id="info-board"></div><div id="info-board-desc" class="abm-caption"></div></td></tr>
      <tr><th>Pins:</th>          <td><div id="info-pins"></div><div id="info-pins-desc" class="abm-caption"></div></td></tr>
      <tr><th>Architectures:</th> <td><div id="info-archs"></div></td></tr>
      <tr><th>Environments:</th>  <td><div id="info-envs"></div></td></tr>
    </table>
    <div id="abm-button-src">
      <div>
        <div class="env-name"></div>
        <button type="button" onclick="msg({ command:'pio', env:'<env>', cmd:'build' })" title="Build"><img src="${btn_build}" /> Build</button>
        <button type="button" onclick="msg({ command:'pio', env:'<env>', cmd:'upload' })" title="Upload"><img src="${btn_upload}" /> Upload</button>
        <button type="button" onclick="msg({ command:'pio', env:'<env>', cmd:'traceback' })" title="Upload (Traceback)"><img src="${btn_debug}" /> Debug</button>
        <button class="clean" type="button" onclick="msg({ command:'pio', env:'<env>', cmd:'clean' })" title="Clean"><img src="${btn_clean}" /> Clean</button>
        <div class="env-more abm-caption"></div>
      </div>
    </div>
    <div id="error"></div>
    <div id="debug-text"><pre class="hilightable config"></pre></div>
  </div>
</div>
<div id="abm-config" class="abm-panel">
  <h1><a href="https://marlinfw.org">Marlin Firmware</a> <span>Configuration Tool</span></h1>
  <div>Configuration Tool Under Construction</div>
</div>
<div id="abm-sidebar">
  <div id="abm-social">
    <a href="https://marlinfw.org/"><img src="${social_mf}" /><span>Marlin Home</span></a>
    <a href="https://github.com/MarlinFirmware/Marlin"><img src="${social_gh}" /><span>Marlin on GitHub</span></a>
    <a href="https://twitter.com/MarlinFirmware"><img src="${social_tw}" /><span>@MarlinFirmware</span></a>
    <a href="https://www.facebook.com/groups/1049718498464482/"><img src="${social_fb}" /><span>Marlin on Facebook</span></a>
    <a href="https://www.youtube.com/channel/UCOnKgXMJ5MOuuPFYVgbFsKA"><img src="${social_yt}" /><span>Marlin on YouTube</span></a>
  </div>
</div>
<div id="abm-footer"><span>&copy; 2020 MarlinFirmware</span></div>
</div>
</body>
</html>`;
}

//
// Handle a command sent from the Web View
//
function handleMessage(m) {
  switch (m.command) {

    case 'wip':
      postWIP();
      break;

    case 'error':
      postError(m.error);
      break;

    case 'ui-ready':
    case 'refresh':
      refreshNewData();
      return;

    case 'pio':
      //vw.showInformationMessage('Starting ' + nicer[m.cmd].toTitleCase() + ' for ' + m.env);
      pio_command(m.cmd, m.env);
      return;
  }
}

//
// ABM command activation event handler
//
var panel, abm_action;
function activate(action) {
  abm_action = action;
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    runSelectedAction();
  }
  else {

    panel = vw.createWebviewPanel(
      'marlinConfig', 'Auto Build Marlin',
      vscode.ViewColumn.One,
      {
        enableCommandUris: true,         // The view can accept commands?
        retainContextWhenHidden: true,   // getState / setState require more work
        enableScripts: true,             // Scripts are needed for command passing, at least?
        localResourceRoots: [
          vscode.Uri.file(abm_path)
        ]
      }
    );

    pv = panel.webview;

    const ipath = path.join(context.extensionPath, 'abm', 'img');
    panel.iconPath = {
      dark: vscode.Uri.file(path.join(ipath, 'favicon-dark.svg')),
      light: vscode.Uri.file(path.join(ipath, 'favicon-light.svg'))
    };

    //
    // Show the URL of the web view CSS
    //
    //var view_url = pv.asWebviewUri(
    //  vscode.Uri.file( path.join(context.extensionPath, 'abm', 'css') )
    //);
    //vw.showInformationMessage("CSS URL is " + view_url);

    //
    // Populate the Web View with a cool UI
    // This method lets us pre-generate the HTML
    //
    pv.html = homeContent();

    //var periodic_reset = setInterval(pv.postMessage, 2000, { command: 'reset' });

    panel.onDidDispose(
      () => {
        panel = null;
        unwatchConfigurations();
        unwatchBuildFolder();
        destroyIPCFile();
      },
      null, context.subscriptions
    );

    // Handle messages from the webview
    pv.onDidReceiveMessage(handleMessage, undefined, context.subscriptions);

    // Create an IPC file for messages from Terminal
    createIPCFile();
  }
}

//
// Run the launch action if unambiguous, otherwise ask.
//
function runSelectedAction() {
  var act = abm_action;
  abm_action = undefined;
  if (act !== undefined) {
    if (act == 'config')
      postWIP();
    else {
      let env;
      if (board_info.envs.length == 1)
        env = board_info.envs[0].name;
      else if (act == 'clean') {
        let cleanme, cnt = 0;
        board_info.envs.forEach((v) => { if (v.exists) { cleanme = v.name; cnt++; } });
        if (cnt == 0) {
          postError('Nothing to clean.');
          return;
        }
        if (cnt == 1) env = cleanme;
      }
      if (env)
        pio_command(act, env);
      else
        postError(`Use a specific environment for ${nicer[act]}.`);
    }
  }
}

module.exports = { init, activate };