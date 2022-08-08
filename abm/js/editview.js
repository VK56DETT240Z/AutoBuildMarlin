'use strict';

// Script to run within the custom editor webview.
(function () {

  String.prototype.toTitleCase = function() { return this.replace(/([A-Z])(\w+)/gi, function(m,p1,p2) { return p1.toUpperCase() + p2.toLowerCase(); }); }
  String.prototype.unbrace = function() { return this.replace(/[\[\]]/g, ''); }
  String.prototype.toLabel = function() { return this.unbrace().replace(/_/g, ' ').toTitleCase(); }
  String.prototype.toID = function() { return this.unbrace().replace(/_/g, '-').toLowerCase(); }
  String.prototype.camelToID = function() { return this.unbrace().replace(/([a-z])([A-Z0-9_])/g, '$1_$2').replace(/_/g, '-').toLowerCase(); }

  // Get a reference to the VS Code webview api.
  // We use this API to post messages back to our extension.
  const vscode = acquireVsCodeApi();

  // On button click send a message back to our extension.
  const $buttonCont = $('.add-button');
  $buttonCont.find('button').bind('click', () => {
    vscode.postMessage({ type: 'hello' });
  })

  const $errorCont = $('<div>', { id: 'error-box', display: 'none' });
  $('body').append($errorCont);

  // A filter text box to filter the list of options.
  var $filter = $('#filter');

  var $shower = $('#show-comments');
  $shower.bind('change', (e) => {
    const $cb = $(e.target), ischecked = $cb.is(':checked');
    console.log('show comments: ' + ischecked);
    $('#config-form .comment').each(function() {
      if (ischecked)
        $(this).removeClass('hide');
      else
        $(this).addClass('hide');
    });
  });

  // Add a change listener to the filter box.
  var filterTimer = null;
  $filter.bind('change keyup', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { applyFilter($("#filter").val()); }, 250);
  });

  $filter.focus(e => {
    // Clear the filter when the user clicks in the filter box.
    $(e.target).val('');
    applyFilter('');
  });

  //const $formdiv = $('#config-form');

  const verbose = false;
  function log(message, line=0) {
    if (verbose) console.log(line ? `[${line}] ${message}` : message);
  }

  function handleCheckbox(e) {
    const $cb = $(e.target);
    // Get the parent div.line of the checkbox.
    const $line = $cb.closest('.line');
    // Get the state of the checkbox.
    const checked = $cb.prop('checked');

    if (!checked) $line.addClass("disabled");
    else $line.removeClass("disabled");

    vscode.postMessage({ type: 'toggle', data: $line[0].itemref, enable: checked });
  }

  function handleEditField(e) {
    const $field = $(e.target),
          $line = $field.closest('.line'),
          value = $field.val();
    console.log(`handleEditField: ${value}`, $line[0]);
    //const id = $field.attr('id');
    vscode.postMessage({ type: 'edit', data: $line[0].itemref, value: value });
  }

  /**
   * Extract structured data from the text of a configuration file.
   */
  function extractConfig(text) {
    log("extractConfig");

    // Parsing states
    const Parse = {
      NORMAL: 0,        // No condition yet
      BLOCK_COMMENT: 1, // Looking for the end of the block comment
      EOL_COMMENT: 2,   // EOL comment started, maybe add the next comment?
      GET_SENSORS: 3,   // Gathering temperature sensor options
      ERROR: 9          // Syntax error
    };

    // Load board names from boards.h
    //const boards = load_boards();
    const boards = [];

    // List of files to process, with shorthand
    const filekey = { 'Configuration.h':'basic', 'Configuration_adv.h':'advanced' };
    // A dictionary to store the data
    var sch_out = {};
    // Regex for #define NAME [VALUE] [COMMENT] with sanitized line
    const defgrep = /^(\/\/)?\s*(#define)\s+([A-Za-z0-9_]+)\s*(.*?)\s*(\/\/.+)?$/;
    // Defines to ignore
    const ignore = ['CONFIGURATION_H_VERSION', 'CONFIGURATION_ADV_H_VERSION', 'CONFIG_EXAMPLES_DIR'];
    // Start with unknown state
    var state = Parse.NORMAL;
    // Serial ID
    var sid = 0;

    // Loop through files and parse them line by line
    var section = 'none',     // Current Settings section
        line_number = 0,      // Counter for the line number of the file
        conditions = [],      // Create a condition stack for the current file
        comment_buff = [],    // A temporary buffer for comments
        options_json = '',    // A buffer for the most recent options JSON found
        eol_options = false,  // The options came from end of line, so only apply once
        join_line = false,    // A flag that the line should be joined with the previous one
        line = '',            // A line buffer to handle \ continuation
        last_added_ref,       // Reference to the last added item
        line_start, line_end; // Start and end of the (joined) line in the file

    // Loop through the lines in the file
    for (let the_line of text.split(/\r?\n/)) {
      line_number++;

      // Clean the line for easier parsing
      the_line = the_line.trim();
      //log(the_line, line_number);

      if (join_line) {  // A previous line is being made longer
        line += (line ? ' ' : '') + the_line;
      }
      else {            // Otherwise, start the line anew
        line = the_line;
        line_start = line_number;
      }

      // If the resulting line ends with a \, don't process now.
      // Strip the end off. The next line will be joined with it.
      join_line = line.endsWith("\\");
      if (join_line) {
        //log("Joining line", line_number);
        line = line.slice(0, -1).trim();
        continue;
      }
      else
        line_end = line_number;

      // Get the match parts for a #define line
      const defmatch = line.match(defgrep);

      // Special handling for EOL comments after a #define.
      // At this point the #define is already digested and inserted,
      // so we have to extend it
      if (state == Parse.EOL_COMMENT) {
        // If the line is not a comment, we're done with the EOL comment
        if (defmatch == null && the_line.startsWith('//')) {
          comment_buff.push(the_line.slice(2).trim());
        }
        else {
          last_added_ref['comment'] = comment_buff.join('\n');
          comment_buff = [];
          state = Parse.NORMAL;
        }
      }

      function use_comment(c, opt, sec, bufref) {
        log(0, `use_comment(c: ${c}, opt: ${opt}, sec: ${sec}, bufref: ...)`);
        if (c.startsWith(':')) {        // If the comment starts with : then it has magic JSON
          const d = c.slice(1).trim(),
              cbr = d.startsWith('{') ? c.lastIndexOf('}') : d.startsWith('[') ? c.lastIndexOf(']') : 0;
          if (cbr) {
            opt = c.slice(1, cbr+1).trim();
            const cmt = c.slice(cbr+1).trim();
            if (cmt != '') bufref.push(cmt);
          }
          else
            opt = c.slice(1).trim();
        }
        else if (c.startsWith('@section'))    // Start a new section
          sec = c.slice(8).trim();
        else if (!c.startsWith('========'))
          bufref.push(c);

        return [opt, sec];
      }

      // In a block comment, capture lines up to the end of the comment.
      // Assume nothing follows the comment closure.
      var cline = '';
      if ([ Parse.BLOCK_COMMENT, Parse.GET_SENSORS ].includes(state)) {

        const endpos = line.indexOf('*/');
        if (endpos < 0)
          cline = line;
        else {
          log(`Comment end-marker`, line_number);
          cline = line.slice(0, endpos).trim();
          line = line.slice(endpos+2).trim();

          // Temperature sensors are done
          if (state == Parse.GET_SENSORS) {
            // Get up to the last 2 characters of the options_json string
            options_json = `[ ${options_json.slice(0, -2)} ]`;
          }

          state = Parse.NORMAL;
          log("Ending block comment", line_number);
        }

        // Strip the leading '*' from block comments
        if (cline.startsWith('*')) {
          //log("Cleaning block comment", line_number);
          cline = cline.slice(1).trim();
        }

        // Collect temperature sensors
        if (state == Parse.GET_SENSORS) {
          const sens = cline.match(/^(-?\d+)\s*:\s*(.+)$/);
          if (sens) {
            log("Sensor: ${sens[1]} = ${sens[2]}", line_number);
            const s2 = sens[2].replace(/'/g, "''");
            options_json += `${sens[1]}:'${s2}', `;
          }
        }
        else if (state == Parse.BLOCK_COMMENT) {
          // Look for temperature sensors
          if (cline == "Temperature sensors available:") {
            state = Parse.GET_SENSORS;
            cline = "Temperature Sensors";
            log("Starting sensors list", line_number);
          }

          const res = use_comment(cline, options_json, section, comment_buff);
          options_json = res[0];
          section = res[1];
        }
      }
      // For the normal state we're looking for any non-blank line
      else if (state == Parse.NORMAL) {
        // Skip a commented define when evaluating comment opening
        const st = line.match(/^\/\/\s*#define/) ? 2 : 0,
           cpos1 = line.indexOf('/*'),      // Start a block comment on the line?
           cpos2 = line.indexOf('//', st);  // Start an end of line comment on the line?

        // Only the first comment starter gets evaluated
        var cpos = -1;
        if (cpos1 != -1 && (cpos1 < cpos2 || cpos2 == -1)) {
          log("Starting block comment", line_number);
          cpos = cpos1;
          comment_buff = [];
          state = Parse.BLOCK_COMMENT;
          eol_options = false;
        }
        else if (cpos2 != -1 && (cpos2 < cpos1 || cpos1 == -1)) {
          cpos = cpos2;

          // Expire end-of-line options after first use
          if (cline.startsWith(':')) eol_options = true;

          // Comment after a define may be continued on the following lines
          if (state == Parse.NORMAL && defmatch != null && cpos > 10) {
            state = Parse.EOL_COMMENT;
            comment_buff = [];
            log("Starting EOL comment");
          }
        }

        // Process the start of a new comment
        if (cpos != -1) {
          cline = line.slice(cpos+2).trim();
          line = line.slice(0, cpos).trim();

          // Strip leading '*' from block comments
          if (state == Parse.BLOCK_COMMENT)
            if (cline.startsWith('*')) cline = cline.slice(1).trim();

          // Buffer a non-empty comment start
          if (cline != '') {
            const res = use_comment(cline, options_json, section, comment_buff);
            options_json = res[0];
            section = res[1];
          }
        }

        // If the line has nothing before the comment, go to the next line
        if (line == '') {
          options_json = '';
          continue;
        }

        // Parenthesize the given expression if needed
        function atomize(s) {
          if (s == ''
            || s.match(/^[A-Za-z0-9_]*(\([^)]+\))?$/)
            || s.match(/^[A-Za-z0-9_]+ == \d+?$/)
          ) return s;
          return `(${s})`;
        }

        //
        // The conditions stack is an array containing condition-arrays.
        // Each condition-array lists the conditions for the current block.
        // IF/N/DEF adds a new condition-array to the stack.
        // ELSE/ELIF/ENDIF pop the condition-array.
        // ELSE/ELIF negate the last item in the popped condition-array.
        // ELIF adds a new condition to the end of the array.
        // ELSE/ELIF re-push the condition-array.
        //
        const drctv = line.split(/\s+/)[0],
              iselif = drctv == '#elif',
              iselse = drctv == '#else';

        if (iselif || iselse || drctv == '#endif') {
          if (conditions.length == 0) {
            //raise Exception(f'no #if block at line {line_number}')
            // TODO: Revert the view back to plain text editing
          }

          log("Handling else/end line", line_number);

          // Pop the last condition-array from the stack
          const prev = conditions.pop();

          if (iselif || iselse) {
            prev[prev.length-1] = '!' + prev[prev.length-1]; // Invert the last condition
            if (iselif) prev.push(atomize(line.slice(5).trim()));
            conditions.push(prev);
          }
        }
        else if (drctv == '#if') {
          conditions.push([ atomize(line.slice(3).trim()) ]);
          log("Handling if line", line_number);
        }
        else if (drctv == '#ifdef') {
          conditions.push([ `defined(${line.slice(6).trim()})` ]);
          log("Handling ifdef line", line_number);
        }
        else if (drctv == '#ifndef') {
          conditions.push([ `!defined(${line.slice(7).trim()})` ]);
          log("Handling ifndef line", line_number);
        }
        else if (defmatch) {
          // Handle a complete #define line

          const define_name = defmatch[3];
          if (ignore.includes(define_name)) continue;

          log(`Found #define ${define_name}`, line_number);

          const enabled = !defmatch[1];
          var val = defmatch[4];

          // Increment the serial ID
          sid++;

          // Type is based on the value
          var value_type;
          if (val == '') {
            value_type = 'switch';
          }
          else if (val.match(/^(true|false)$/i)) {
            value_type = 'bool';
            val = val == 'true';
          }
          else if (val.match(/^[-+]?\s*\d+$/)) {
            value_type = 'int';
            val = val * 1;
          }
          else if (val.match(/^[-+]?\s*(\d+\.|\d*\.\d+)([eE][-+]?\d+)?[fF]?$/)) {
            value_type = 'float'
            val = val.replace('f','') * 1;
          }
          else {
            value_type = (
                val[0] == '"' ? 'string'
              : val[0] == "'" ? 'char'
              : val.match(/^(LOW|HIGH)$/i) ? 'state'
              : val.match(/^[A-Z0-9_]{3,}$/i) ? 'enum'
              : val.match(/^{(\s*[-+]?\s*\d+\s*(,\s*)?)+}$/) ? 'int[]'
              : val.match(/^{(\s*[-+]?\s*(\d+\.|\d*\.\d+)([eE][-+]?\d+)?[fF]?\s*(,\s*)?)+}$/) ? 'float[]'
              : val[0] == '{' ? 'array'
              : ''
            );
          }

          // Create a new dictionary for the current #define
          var define_info = {
            'section': section,
            'name': define_name,
            'enabled': enabled,
            'line': line_start,
            'sid': sid
          };

          if (val != '') define_info['value'] = val;
          if (value_type != '') define_info['type'] = value_type;
          if (conditions) define_info['requires'] = conditions.join(' && ');

          // If the comment_buff is not empty, add the comment to the info
          if (comment_buff) {
            const full_comment = comment_buff.join('\n');

            // An EOL comment will be added later
            // The handling could go here instead of above
            if (state == Parse.EOL_COMMENT) {
              define_info['comment'] = '';
            }
            else {
              define_info['comment'] = full_comment;
              comment_buff = [];
            }

            // If the comment specifies units, add that to the info
            var units = full_comment.match(/^\(([^)]+)\)/);
            if (units) {
              units = units[1];
              if (['s', 'sec'].includes(units)) units = 'seconds';
              define_info['units'] = units;
            }
          }

          // Set the options for the current #define
          if (define_name == "MOTHERBOARD" && boards != '') {
            define_info['options'] = boards;
          }
          else if (options_json != '') {
            define_info['options'] = options_json;
            if (eol_options) options_json = '';
          }

          // Create section dict if it doesn't exist yet
          if (!(section in sch_out)) sch_out[section] = {};

          // If define has already been seen...
          if (define_name in sch_out[section]) {
            var info = sch_out[section][define_name];
            if (!(info instanceof Array)) info = [ info ];    // Convert a single dict into a list
            info.push(define_info);                         // Add to the list
            log(`Duplicate #define ${define_name}`, line_number);
          }
          else {
            // Add the define dict with name as key
            sch_out[section][define_name] = define_info;
            log(`Added a define for ${define_name} to ${section}`, line_number);
          }

          if (state == Parse.EOL_COMMENT) last_added_ref = define_info;
        }
      }
    }
    return sch_out
  }

  function applyFilter(text) {
    $sects = $(`#config-form fieldset.section`);
    // Using jQuery, match all divs with an id matching the filter, and which have class 'line'
    // Then, show them, and hide all others
    if (text.length < 3) {
      log("Showing all options");
      $sects.removeClass('hide');
      $('#config-form div.line').removeClass('hide');
    }
    else {
      // Split up the filter text into words
      const words = text.toLowerCase().split(' ');
      // Get all lines and hide them by default
      var $lines = $(`#config-form div.line`).addClass('hide');
      // Get only lines that have all words in their id
      for (var word of words) {
        if (word.length > 1) $lines = $lines.filter(`[id*="${word}"]`);
      }
      $lines.removeClass('hide');

      var $sects = $sects.addClass('hide');
      for (var sect of $sects) {
        // Select all the div.line without class 'hide'
        var $lines = $(sect).find('div.line:not(.hide)');
        if ($lines.length > 0) $(sect).removeClass('hide');
      }

      log(`Applied filter '${text}'`);
    }
  }

  /**
   * Render the document in the webview.
   */
  function updateContent(text) {
    log("============ updateContent ============");

    const data = extractConfig(text);
    //console.log("Extracted data", data);

    // Bind click event to the revealer
    const do_reveal = (clas) => {
      $("fieldset." + clas).find(".section-inner").toggleClass("active");
    };

    // Iterate over the config data and create a form
    const $form = $("<form>");
    for (const [key, dict] of Object.entries(data)) {
      const keyid = key.toID();
      log(`${key} =====================`);
      // Create a form group for each section
      const $fieldset = $(`<fieldset class="section ${keyid}">`),
            $revealer = $(`<legend class="section-revealer"><span class="section-title">${key.toLabel()}</span></legend>`),
            $inner = $(`<div class="section-inner">`);

      $revealer.find(".section-title").click(() => { do_reveal(keyid); }); // Bind click event to the revealer

      // Iterate over the keys in the dict object
      for (const [define, info] of Object.entries(dict)) {
        const isswitch = info['type'] == 'switch',
              val = info['value'] !== undefined ? info['value'] : '',
              ena = info['enabled'];
        log(`${define} = ${val}`);
        if (info instanceof Array) info = info[0]; // TODO: Handle multiple defines
        const $linediv = $("<div>", { id: "-" + define.toID(), class: "line" }),
              $linelabel = $("<label>"),
              $labelspan = $("<span>").text(define.toLabel()),
              $linecb = $("<input>", { type: "checkbox", name: define, checked: ena }).bind("change", handleCheckbox);

        if (!ena) $linediv.addClass("disabled");
        $linelabel.append($linecb).append($labelspan);
        $linediv.append($linelabel);
        if (!isswitch) {
          const $input = $("<input>", { type: "text", name: define, value: val }).bind("change keyup", handleEditField);
          $linediv.append($input);
        }
        if (info['comment']) {
          const $cspan = $("<span>").text(info['comment']),
          $cdiv = $("<div>", { class: "comment" }).append($cspan);
          if (isswitch) $cdiv.addClass("switch");
          $linediv.append($cdiv);
        }
        $linediv[0].itemref = info;
        $inner.append($linediv);
        //console.log("Added a line for", define);
      }

      $fieldset.append($revealer).append($inner);
      $form.append($fieldset);
      //console.log("Added field set for", key);
    }

    $('#config-form').html('').append($form);
  }

  // Handle messages sent from the extension to the webview
  window.addEventListener('message', (e) => {
    const message = e.data; // The data that the extension sent
    log("Got a message", message);
    switch (message.type) {

      // Display an error message
      case 'error':
        $('#error').text(message.text).show().click(() => { $('#error').hide(); });
        return;

      // Handle a message telling us to update part of the document
      // It contains the new text and the range that should be replaced
      case 'update':
        log("Got an update message", message);

        const text = message.text;

        // Update our webview's content
        updateContent(text);

        // Then persist state information.
        // This state is returned in the call to `vscode.getState` below when a webview is reloaded.
        vscode.setState({ text });
        return;
    }
  });

  // Webviews are normally torn down when not visible and re-created when they become visible again.
  // State lets us save information across these re-loads.
  const state = vscode.getState();
  if (state) updateContent(state.text);

})();
