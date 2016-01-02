'use strict';

var ChromeWindow = require('sdk/window/utils').getMostRecentBrowserWindow('navigator:browser');
var SimplePrefs = require('sdk/simple-prefs');
var Locales = require('sdk/l10n').get;
var {Cc, Ci, Cu} = require('chrome');
var {Downloads} = Cu.import('resource://gre/modules/Downloads.jsm', {});
var {TextDecoder, TextEncoder, OS} = Cu.import('resource://gre/modules/osfile.jsm', {});
var {Services} = Cu.import('resource://gre/modules/Services.jsm', {});
var {WebRequest} = Cu.import('resource://gre/modules/WebRequest.jsm', {});
var {MatchPattern} = Cu.import('resource://gre/modules/MatchPattern.jsm');

var Directories = {
  profile: OS.Path.join(OS.Constants.Path.profileDir, 'SimpleFilter'),
  firefox: OS.Path.join(OS.Constants.Path.libDir, 'browser', 'SimpleFilter'),
  winuser: OS.Path.join(OS.Constants.Path.homeDir, 'SimpleFilter'),
  addFolder: function () {
    OS.File.makeDir(this.profile);
  }
};

var Profiles = new Object();
var SimpleList = { filter: new Array(), redirect: new Array() };

var Preferences = {
  pending: function () {
    for (var i = 0; i < 5; i ++) {
      Profiles[i] = { debug: 'inProfile' + i };

      this.manifest('filter_list_' + i, Profiles[i]);

      this.onClick(i);
    }

    SimplePrefs.on('', function (name) {
      var number = name.split('_')[2];
      Preferences.manifest(name, Profiles[number]);
    });

    SimpleFilter.filter();
    SimpleFilter.redirect();
  },
  onClick: function (number) {
    SimplePrefs.on('edit_list_' + number, function () {
      Execution.editor(Profiles[number]);
    });
  },
  manifest: function (name, profile) {
    profile['list'] = SimplePrefs.prefs[name];
    Execution.predict(profile);
  }
};

var Feeds = {
  analyze: function (profile) {
    OS.File.stat(profile.file).then(
      function onSuccess(data) {
        if (Date.parse(data.lastModificationDate) + 4 * 86400000 < Date.now()) {
          Feeds.fetch(profile);
        } else {
          Execution.scan(profile);
        }
      },
      function onFailure(reason) {
        if (reason instanceof OS.File.Error && reason.becauseNoSuchFile) {
          Feeds.fetch(profile);
        }
      }
    );
  },
  fetch: function (profile, probe) {
    if (probe == undefined) probe = 0;
    if (probe > 3) return ChromeWindow.console.log(Locales('fetchFailed') + '\r\n' + Locales(profile.debug));

    probe ++;
    var temp = profile.file + '_sp';
    Downloads.fetch(profile.list, temp, {isPrivate: true}).then(
      function onSuccess() {
        OS.File.move(temp, profile.file);
        Execution.scan(profile);
      },
      function onFailure() {
        Directories.addFolder();
        Feeds.fetch(profile, probe);
      }
    );
  }
};

var Execution = {
  predict: function (profile) {
    if (!profile.list) return profile.file = undefined;

    if (profile.list.match(/^https?:\/\/([^\/]+\/)+[^\\\?\/\*\|<>:"]+\.[a-z]+$/i)) {
      profile.file = OS.Path.join(Directories.profile, profile.list.split('/')[profile.list.split('/').length - 1]);
      profile.noedit = true;
      Feeds.analyze(profile);
    } else if (profile.list.match(/^\w:\\([^\\]+\\)*[^\\\?\/\*\|<>:"]+\.[a-z]+$/i)) {
      profile.file = profile.list;
      this.scan(profile);
    } else if (profile.list.match(/^[^\\\?\/\*\|<>:"]+\.[a-z]+@(profile|firefox|winuser)$/i)) {
      var folder = profile.list.split('@')[1];
      var listname = profile.list.split('@')[0];
      profile.file = OS.Path.join(Directories[folder], listname);
      this.scan(profile);
    } else {
      return ChromeWindow.console.log(Locales('invalidRulelist') + '\r\n' + Locales(profile.debug));
    }
  },
  scan: function (profile) {
    OS.File.read(profile.file).then(
      function onSuccess(array) {
        var decoder = new TextDecoder();
        var data = decoder.decode(array);

        try {
          var list = ChromeWindow.atob(data).split(/[\r\n]+/);
        } catch (e) {
          var list = data.split(/[\r\n]+/);
        }

        for (var i in list) {
          if (list[i].startsWith('$')) {
            Execution.normalize(SimpleList.filter, list[i].substr(1));
          } if (list[i].startsWith('^')) {
            Execution.normalize(SimpleList.redirect, list[i].substr(1));
          }
        }
      },
      function onFailure(reason) {
        if (reason instanceof OS.File.Error && reason.becauseNoSuchFile) {
          ChromeWindow.console.log(Locales('fileNotExsit') + '\r\n' + Locales(profile.debug));
        }
      }
    );
  },
  normalize: function (list, rule) {
    if (rule.includes('@')) {
      var attribute = rule.split('@')[1];
      if (attribute.includes('|')) {
        var filter = new Array();
        for (var i in attribute.split('|')) {
          filter.push(attribute.split('|')[i]);
        }
      }

      SimpleFilter.worker(list, string, filter);
    } else {
      SimpleFilter.worker(list, rule);
    }
  },
  editor: function (profile) {
    if (profile.noedit || !profile.file) return;

    OS.File.read(profile.file).then(
      function onSuccess(array) {
        var decoder = new TextDecoder();
        var data = decoder.decode(array);

        var ScratchpadManager = ChromeWindow.Scratchpad.ScratchpadManager;
        ScratchpadManager.openScratchpad({
          'filename': profile.file,
          'text': data,
          'saved': true
        }).addEventListener(
          'click',
          function click(event) {
            if (event.target.id == 'sp-toolbar-save') {
              event.target.ownerDocument.defaultView.addEventListener(
                'close',
                function close(event) {
                  Execution.scan(profile);
                },
                false
              );
            }
          },
          false
        );
      },
      function onFailure(reason) {
        if (reason instanceof OS.File.Error && reason.becauseNoSuchFile) {
          return ChromeWindow.console.log(Locales('fileNotExsit') + '\r\n' + Locales(profile.debug));
        }
      }
    );
  }
};

var SimpleFilter = {
  worker: function (list, rule, filter) {
    if (rule.includes('>')) {
      var string = rule.split('>')[0];
      var target = rule.split('>')[1];
      var pattern = new MatchPattern(string);

      list.push([pattern, filter, target]);
    } else {
      var pattern = new MatchPattern(rule);

      list.push([pattern, filter]);
    }
  },
  matcher: function (pattern, filter, url, type) {
    if (filter) {
      if (pattern.matches(url) && filter.indexOf(type) > -1) return true;
    } else {
      if (pattern.matches(url)) return true;
    }
  },
  filter: function (event) {
    for (var i in SimpleList.filter) {
      var pattern = SimpleList.filter[i][0];
      var filter = SimpleList.filter[i][1];
      var url = Services.io.newURI(event.url, null, null);
      var type = event.type;

      if (SimpleFilter.matcher(pattern, filter, url, type)) return {cancel: true};
    }
  },
  redirect: function (event) {
    for (var i in SimpleList.redirect) {
      var pattern = SimpleList.redirect[i][0];
      var filter = SimpleList.redirect[i][1];
      var target = SimpleList.redirect[i][2];
      var url = Services.io.newURI(event.url, null, null);
      var type = event.type;

      if (SimpleFilter.matcher(pattern, filter, url, type)) return {redirectUrl: target};
    }
  }
};

exports.main = function (options, callbacks) {
  SimplePrefs.prefs['description'] = Locales('Simple Filter');
  Preferences.pending();
  WebRequest.onBeforeRequest.addListener(SimpleFilter.filter, null, ['blocking']);
  WebRequest.onBeforeSendHeaders.addListener(SimpleFilter.redirect, null, ['blocking']);
};

exports.onUnload = function (reason) {
  WebRequest.onBeforeRequest.removeListener(SimpleFilter.filter);
  WebRequest.onBeforeSendHeaders.removeListener(SimpleFilter.redirect);
};
