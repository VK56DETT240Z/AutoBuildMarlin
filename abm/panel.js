/**
 * Auto Build Marlin
 * abm/panel.js - ABM Panel methods.
 */

const marlin = require('./marlin'),
       prefs = require('./prefs'),
        path = require('path'),
          fs = require('fs'),
          os = require('os');

const vscode = require('vscode'),
          vc = vscode.commands,
          ws = vscode.workspace,
          vw = vscode.window;

var context, pv, abm_path, pane_path;

// Update based on "when" in package.json
function set_context(name, value) {
  vc.executeCommand('setContext', 'abm.' + name, value);
}

const bugme = false; // Lots of debug output
function log(s, d=null) {
  if (bugme) { console.log(s); if (d) console.dir(d); }
}

function init(c) {
  marlin.init(bugme);
  //context = c;
  abm_path = path.join(c.extensionPath, 'abm');
  pane_path = path.join(c.extensionPath, 'abm', 'pane');
  set_context('inited', true);
}

/**
 * The simplest layout concept is to take the entire config
 * and parse it in a big list. Parent items are at root, and
 * those with children have a colored background and a
 * "reveal" widget. Child items should be compact so we can fit
 * 2-3 fields across. Grouped (XYZE) items need to align left.
 *
 * I do want to make the layouts customized for each configuration,
 * but I also want the flexibility to grab fields from the config
 * files as they change. So, my idea is simply to wrap all the fields
 * in span containers. To create the panel, we send all the fields
 * in the relevant section to the web view script as soon as the panel
 * is selected. The web view takes care of creating the fields, adding
 * them to the DOM, and showing the panel. The CSS uses a FLEX layout
 * with certain named spans included, while the ones not named in the
 * layout will be placed into the "fallback" location, probably down
 * at the bottom.
 *
 * For the Geometry panel a simple hook is added to update the canvas
 * whenever the fields are updated. And the canvas has interactive bits
 * that update the geometry fields. If there is a pause of a few seconds
 * or the panel is switched then the changes are applied to the configs.
 */

// Return the path to the given item within the build folder.
function envBuildPath(env, item) {
  var bp = path.join(marlin.workspaceRoot, '.pio', 'build', env);
  if (item !== undefined) bp = path.join(bp, item);
  return bp;
}

/**
 * Find an existing build folder. If 'debug' exists, prefer it.
 */
function existingBuildPath(env, item) {
  var bp = envBuildPath(env, 'debug');
  if (item !== undefined) bp = path.join(bp, item);
  if (fs.existsSync(bp)) return bp;
  return envBuildPath(env, item);
}

function existingBuildPathOrNull(env, item) {
  var bp = existingBuildPath(env, item);
  return fs.existsSync(bp) ? bp : null;
}

/**
 * Watch Configuration*.h files for changes and refresh the view
 * The fs.watch event is fast and usually sends several events.
 * So instead of calling refreshNewData directly, put it on a timeout.
 */

var timeouts = [];
function onConfigFileChanged(e, fname) {
  log(`File changed (${fname}):`, e);
  if (timeouts[fname] !== undefined) clearTimeout(timeouts[fname]);
  timeouts[fname] = setTimeout(() => {
    timeouts[fname] = undefined;
    refreshNewData();
  }, 2000);
}

/**
 * An Environment can be in one of these states:
 *  - Does not exist. No Clean option.
 *  - Exists and has completed build. Show a Clean option.   .exists
 *  - Exists and has incomplete build. Show a Clean option.  .exists.incomplete
 *  - Does not exist but build started. Hide all buttons.    .busy
 *  - Exists and build is underway. Hide all buttons.        .exists.busy
 *
 * The strategy is to watch the build folder for changes up to the
 * state where the build is underway and the env folder exists.
 *
 * After that the IPC file signals when the build is done.
 */

var build = { watcher:null, env:null, active:false };
function currentBuildEnv() {
  return build.active ? build.env : '(none)';
}

//
// Stop watching the build folder
//
function unwatchBuildFolder() {
  if (build.watcher) {
    log(`Stop Watching Build: ${currentBuildEnv()}.`);
    build.watcher.close();
    build.watcher = null;
  }
  if (build.env)
    refreshBuildStatus(build.env);
}

/**
 * Watch the build folder for changes in *any* contents.
 * As long as contents are changing, a build is occurring.
 * Use the cancel-restart method to keep putting off the UI
 * update. Only the last timeouts will actually occur.
 */
function watchBuildFolder(env) {
  if (!build.watcher) {
    const bp = existingBuildPathOrNull(env);
    if (bp) {
      build.watcher = fs.watch(bp, {}, (e,f) => { onBuildFolderChanged(e,f,env); });
      log("Watching Build...");
    }
    else {
      // Build folder doesn't exist (yet)
      // Keep looking for it for several seconds
      log("No build folder yet. Trying in 2s...");
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
  log(`buildIsFinished (${reason}): ${currentBuildEnv()}`);

  // Updating now so kill timers
  cancelBuildRefresh();

  // Stop watching the build folder for changes.
  // If build.env is set it will also update the UI.
  build.active = false;
  unwatchBuildFolder();

  // If the build should be revealed, do it now.
  if (prefs.auto_reveal()) reveal_env_build(build.env);

  // Clear the environment
  build.env = null;
}

function onIPCFileChange() {
  buildIsFinished('IPC File Change');  // Assume the build is completed. TODO: Verify contents of the IPC file.
}

function onBuildFolderChanged(e, fname, env) {
  cancelBuildRefresh();

  if (/(.+\.(bin|hex|exe|srec)|program|MarlinSimulator)$/i.test(fname)) {
    // If the BIN or HEX file changed, assume the build is done now
    refresh_to.push(setTimeout(()=>{ unwatchBuildFolder(); }, 500));
    log(`onBuildFolderChanged (firmware binary): ${env}`);
  }
  else {
    // Set timeouts that assume lots of changes are underway
    refresh_to.push(setTimeout(()=>{ refreshBuildStatus(env); }, 500));
    // Assume nothing will pause for more than 15 seconds
    refresh_to.push(setTimeout(()=>{ unwatchBuildFolder(); }, 15000));
    log(`onBuildFolderChanged: ${env}`);
  }
}

function postMessage(msg) {
  log("Posting:", msg);
  pv.postMessage(msg);
}

// Local reference to parsed board info
var board_info;

/**
 * Process data now that all files are loaded
 *
 *  - Read values from the config files
 *  - Update the UI with initial values
 */
function allFilesAreLoaded() {

  set_context('err.parse', false);

  // Send text for display in the view
  //postMessage({ command:'text', text:marlin.files.boards.text });

  const mb = marlin.configValue('MOTHERBOARD');

  if (mb !== undefined) {

    //const sensors = extractTempSensors();
    //log("Sensors :", sensors);

    const version_info = marlin.extractVersionInfo();
    log("Version Info :", version_info);
    board_info = marlin.extractBoardInfo(mb);
    log(`Board Info for ${mb} :`, board_info);
    set_context('has_debug', !!board_info.has_debug);
    if (board_info.error) {
      set_context('err.parse', true);
      postError(board_info.error);
      return; // abort the whole deal
    }
    const machine_info = marlin.getMachineSettings();
    log("Machine Info :", machine_info);
    const extruder_info = marlin.getExtruderSettings();
    log("Extruder Info :", extruder_info);
    const pindef_info = marlin.getPinDefinitionInfo(mb);
    log("Pin Defs Info :", pindef_info);

    // If no CUSTOM_MACHINE_NAME was set, get it from the pins file
    if (!machine_info.name) {
      let def = marlin.confValue('pindef', 'DEFAULT_MACHINE_NAME');
      if (!def || def == 'BOARD_INFO_NAME')
        def = pindef_info.board_name;
      machine_info.name = def ? def.dequote() : '3D Printer';
    }

    // Post values to the UI filling them in by ID
    postValue('auth', version_info.auth);
    postValue('vers', version_info.vers);

    const d = new Date(version_info.date);
    postValue('date', d.toLocaleDateString([], { weekday:'long', year:'numeric', month:'short', day:'numeric' }));

    postValue('extruders', extruder_info.extruders);
    postValue('extruder-desc', extruder_info.description);

    postValue('machine', machine_info.name);
    postValue('machine-desc', machine_info.description);

    postValue('board', mb.replace('BOARD_', '').replace(/_/g, ' '));
    postValue('board-desc', board_info.description);

    const pf = board_info.pins_file;
    const pinsPath = path.join('Marlin', 'src', 'pins', pf);
    postValue('pins', pf, pinsPath);
    if (pindef_info.board_name) postValue('pins-desc', pindef_info.board_name);

    postValue('archs', board_info.archs);

    // Fill in the build status in the UI
    refreshBuildStatus();
  }

  //marlin.refreshDefineList();

  marlin.watchConfigurations(onConfigFileChanged);
  runSelectedAction();
}

function readFileError(err, msg) {
  log("fs.readFile err: ", err);
  postMessage({ command:'error', error:msg, data:err });
}

//
// Check for valid Marlin files
//
function validate(do_report) {
  const result = marlin.validate();                     // Let the data model validate itself
  if (!result.ok && do_report) postError(result.error); // Post the error, if flagged
  set_context('err.locate', !result.ok);                // Provide context for welcome messages
  return result.ok;                                     // Return 'true' for valid Marlin files
}

//
// Watch project files and call validate() if changed
//
function watchAndValidate() {
  marlin.watchAndValidate(validate);
}

//
// Reload files and refresh the UI
//
function refreshNewData() {
  if (validate(true))
    marlin.refreshAll(allFilesAreLoaded, readFileError);
  else
    postError('Please <a href="#" onclick="msg({ command:\'open\' })">open Marlin 2.x</a> in the workspace.');
}

//
// Get information about the last (or current) build
//  - exists, completed, busy, stamp
//
function lastBuild(env) {
  var bp = existingBuildPath(env),
      src_path = path.join(bp, 'src'),
      out = {
        exists: fs.existsSync(src_path),
        completed: false,
        busy: build.active && build.env == env,
        stamp: ''
      };

  // If the build folder exists...
  if (out.exists) {

    // Find a 'program', .exe, .bin, or .hex file in the folder
    const dirlist = fs.readdirSync(bp);
    const bins = dirlist.filter((n) => {
      return n.match(/(.+\.(bin|hex|exe|srec)|program|MarlinSimulator)$/i);
    });

    var tp = bp;
    if (bins.length) {
      tp = existingBuildPath(env, bins[bins.length-1]);
      out.filename = bins[bins.length-1];
      out.completed = true;
    }

    // Get the date of the build (or folder)
    let stat = fs.lstatSync(tp),
           d = new Date(stat.mtime),
        locd = d.toLocaleDateString([], { weekday:'long', year:'numeric', month:'short', day:'numeric' }),
        loct = d.toLocaleTimeString([], { timeStyle:'medium' });

    out.stamp = `at ${loct} on ${locd}`;
  }
  return out;
}

function getBuildStatus(env) {
  const len = board_info.envs.length;
  for (let i = 0; i < len; i++)
    if (board_info.envs[i].name == env)
      return board_info.envs[i];
  return null;
}

//
// - Refresh the build status for one or more environments.
// - Send the envs data to the UI for display.
//
function refreshBuildStatus(env) {
  log(`Refreshing Build: ${currentBuildEnv()}`, board_info);
  board_info.has_clean = false;
  board_info.envs.forEach((v) => {
    if (!env || v.name == env) {
      let b = lastBuild(v.name);
      v.exists    = b.exists;
      v.completed = b.completed;
      v.filename  = b.filename;
      v.stamp     = b.stamp;
      v.busy      = b.busy;
      if (b.exists) board_info.has_clean = true;
    }
  });
  postMessage({ command:'envs', val:board_info.envs });
  set_context('cleanable', board_info.has_clean);
}

//
// Start a PlatformIO command, update the UI, and watch the build.
//
function pio_command(opname, env, nosave) {

  if (build.active) {
    postError(`A build (${build.env}) is already underway.`);
    return;
  }

  if (prefs.default_env_update()) prefs.set_default_env(env);

  let args;
  switch (opname) {
    case 'run':
      run_built_exe(env); // Run the built native target, if there is one
      return;
    case 'build':     args = 'run';                 break;
    case 'clean':     args = 'run --target clean';  break;
    case 'traceback':
    case 'upload':    args = 'run --target upload'; break;
    default:
      vw.showErrorMessage('Unknown action: "' + opname + '"');
      return;
  }
  if (!nosave) vc.executeCommand('workbench.action.files.saveAll');

  if (prefs.silent_build()) args += " --silent"
  terminal_command(opname, `platformio ${args} -e ${env}`);

  // Show the build as 'busy'
  build.env = env;
  build.active = true;
  refreshBuildStatus(env);

  // Start watching the build folder.
  // (Will wait until the folder gets created.)
  if (opname != 'clean') watchBuildFolder(env);
}

const nicer = {
  build: 'build',
  upload: 'upload',
  traceback: 'upload (traceback)',
  clean: 'clean',
};

// Send a Warning message for display
function postWarning(msg, data) {
  postMessage({ command:'warning', warning:msg, data:data });
}

// Send an Error message for display
function postError(msg, data) {
  postMessage({ command:'error', error:msg, data:data });
}

// Send a Tool Select message
function postTool(t) {
  postMessage({ command:'tool', tool:t });   // Send a tool message back
}

// Post a value to the UI
function postValue(tag, val, uri) {
  var message = { command:'info', tag:tag, val:val };
  if (uri) message.uri = uri;
  log("Send to UI", message);
  postMessage(message);
}

//
// HTML Templates with interpreted Javascript
//

// Get WebView-safe local file URIs
function subpath_uri(sub, filename) {
  var fullpath = (sub !== undefined) ? path.join(abm_path, sub) : abm_path;
  if (filename !== undefined) fullpath = path.join(fullpath, filename);
  return pv.asWebviewUri(vscode.Uri.file(fullpath));
}
function img_path(filename) { return subpath_uri('img', filename); }
function js_path(filename) { return subpath_uri('js', filename); }
function css_path(filename) { return subpath_uri('css', filename); }
function check(b) { return b ? 'checked="checked"' : ''; }

function load_home() {
  return fs.readFileSync(path.join(abm_path, 'abm.html'), {encoding:'utf8'});
}
function load_pane(name, data) {
  var html = fs.readFileSync(path.join(pane_path, name + '.html'), {encoding:'utf8'});
  return eval(`\`${html}\``);
}

// Contents of the Web View
function webViewContent() {
  var panes = {};

  // Load Geometry pane
  panes.geometry = load_pane('geom');

  // Load LCD pane
  panes.lcd = load_pane('lcd');

  // Load SD pane
  panes.sd = load_pane('sd');

  // Load WebView content using evaluated template
  const home_html = load_home();
  const nonce = getNonce();
  merged_html = eval(`\`${home_html}\``);
  return merged_html;
}

//
// Handle a command sent from the ABM WebView.
// Commands are sent using the msg() function defined in abm.html.
//
function handleMessage(m) {
  //console.log('handleMessage', m);
  switch (m.command) {

    case 'openfolder':
      vc.executeCommand('vscode.openFolder');
      break;

    case 'openfile':
      // Open a file in the editor
      vw.showTextDocument(vscode.Uri.file(path.join(marlin.workspaceRoot, m.uri)));
      break;

    case 'tool':
      // On tool selection, re-populate the selected view
      //vw.showInformationMessage('Tool: ' + m.tool);
      break;

    case 'conf':
      // On config section selection, re-populate the selected view
      //vw.showInformationMessage('Config Tab: ' + m.tab);
      break;

    case 'warning':
      postWarning(m.warning); // Warning is echoed back to the view
      break;

    case 'error':
      postError(m.error);    // Error is just echoed back to the view but could also be handled here
      break;

    case 'ui-ready':         // View ready
    case 'refresh':          // Refresh button
      refreshNewData();      // Reload configs and refresh the view
      return;

    case 'monitor':          // Monitor button
      vc.executeCommand('platformio-ide.serialMonitor');
      return;

    case 'show_on_startup':  // Show on Startup checkbox
      prefs.set_show_on_startup(m.value);
      return;

    case 'silent_build':     // Silent Build checkbox
      prefs.set_silent_build(m.value);
      return;

    case 'auto_reveal':     // Auto Reveal checkbox
      prefs.set_silent_build(m.value);
      return;

    case 'pio':              // Build, Upload, Clean...
      //vw.showInformationMessage('Starting ' + nicer[m.cmd].toTitleCase() + ' for ' + m.env);
      pio_command(m.cmd, m.env);
      return;

    case 'reveal':           // Reveal the built BIN or HEX file
      reveal_env_build(m.env);
      return;
  }
}

module.exports = { init, set_context, run_command, validate, watchAndValidate, sponsor, getNonce };