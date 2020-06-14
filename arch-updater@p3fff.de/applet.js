const Main = imports.ui.main;
const Lang = imports.lang;
const Applet = imports.ui.applet;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Gettext = imports.gettext;
const UUID = "arch-updater@p3fff.de";
const St = imports.gi.St;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;

const AUState = {
    Start:          0,
    Checking:       1,
    CheckResult:    2,
    Updating:       3,
    Error:          4
};

   


Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "./local/share/locale");

function _(str) {
    return Gettext.dgettext(UUID, str)
}

function MyApplet(orientation, panelHeight, instanceId) {
    this._init(orientation, panelHeight, instanceId);
}

MyApplet.prototype = {
    __proto__: Applet.TextIconApplet.prototype,

     // #############################################################
     // constructor
    _init: function(orientation, panelHeight, instanceId) {
        Applet.TextIconApplet.prototype._init.call(this, orientation);

        try {
            this._TimerID = null;
            this.res = null;
            this._panelheight = panelHeight;

            this._updateProcess_sourceId = null;
            this._updateProcess_stream = null;
            this._updateProcess_pid = null;

            this.monitor_dir = null;
            this.monitor = null;

            this._updateList = [ ];

            this._applet_label.add_style_class_name("arch-applet-label");
            this.set_applet_tooltip(_("Manage Arch Linux Updates"));


            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this.menu = new Applet.AppletPopupMenu(this, orientation);
            this.menuManager.addMenu(this.menu);

            // ### packet list selectable as sub menu
            this.menuExpander = new PopupMenu.PopupSubMenuMenuItem('');

            // ### the list itself as label (packets are separated with newlines)
            this.updatesListMenuLabel = new St.Label({style_class: 'arch-updates-list'});
//            this.updatesListMenuLabel.set_text(this._updateList.join("\n"));
            this.menuExpander.menu.box.add(this.updatesListMenuLabel);
            this.menu.addMenuItem(this.menuExpander);

            this._CheckNowItem = new PopupMenu.PopupIconMenuItem(_("Check now"), "", St.IconType.SYMBOLIC);
            this._CheckNowItem.connect('activate', Lang.bind(this, this._doCheckForUpdateCommand, 0));
            this.menu.addMenuItem(this._CheckNowItem);

            this._contentSection = new PopupMenu.PopupMenuSection();
            this._contentSection.actor.add_actor(this._CheckNowItem.actor);
            this.menu.addMenuItem(this._contentSection);

            let item = new PopupMenu.PopupIconMenuItem(_("Update now"), "arch-uptodate-symbolic", St.IconType.SYMBOLIC);
            item.connect('activate', Lang.bind(this, this._doUpdateCommand, 0));
            this.menu.addMenuItem(item);


            this.menu.connect('open-state-changed', Lang.bind(this, this._onMenuOpened));
                


            // Load settings
            this.settings = new Settings.AppletSettings(this, "arch-updater@p3fff.de", instanceId);
            this.settings.bindProperty(Settings.BindingDirection.IN, "boot-wait", "pref_bootwait", null, null);
            this.settings.bindProperty(Settings.BindingDirection.IN, "check-interval", "pref_checkinterval", this.on_settings_changed, null);
            this.settings.bindProperty(Settings.BindingDirection.IN, "always-visible", "pref_alwaysvisible", null, null);
            this.settings.bindProperty(Settings.BindingDirection.IN, "strip-versions", "pref_stripversions", null, null);
            this.settings.bindProperty(Settings.BindingDirection.IN, "check-cmd", "pref_checkcmd", null, null);
            this.settings.bindProperty(Settings.BindingDirection.IN, "update-cmd", "pref_updatecmd", null, null);
            this.settings.bindProperty(Settings.BindingDirection.IN, "pacman-dir", "pref_pacmandir", null, null);
            this.settings.bindProperty(Settings.BindingDirection.IN, "max-items-to-open-automatically", "pref_maxitemstoshow", null, null);


            // initialize the first check which should be performed after bootwait seconds
            this._TimerID = Mainloop.timeout_add_seconds(this.pref_bootwait, () => {
                                      this._timerCheckForUpdate(true);
                                      return true;
                                    });


            this._setState(AUState.Start)
//            global.logError("arch updater restart");

            this._startFolderMonitor();
            

            
        }
        catch (e) {
            global.logError(e);
        }
    },


    // #############################################################
    // #############################################################
    _setState(newState)
    {
      try{
        if (newState != this._iState)
        {
          switch (this._iState)
          {
            case AUState.Checking:
              this._CheckNowItem.actor.reactive = true;
  //            this._CheckNowItem.actor.reactive = disabled;
              break;
          }
        }
        switch (newState)
        {
          case AUState.Start:
              this.set_applet_icon_name("arch-unknown-symbolic");
              this.menuExpander.label.set_text('Waiting first check');
              this.menuExpander.actor.reactive = false;
              this.menuExpander._triangle.visible = false;
            break;
          case AUState.Checking:
              this.set_applet_icon_name("arch-unknown-symbolic");
              this.set_applet_label("");
              this.menuExpander.actor.reactive = false;
              this.menuExpander._triangle.visible = false;
            break;
          case AUState.CheckResult:
              if (this._updateList.length == 0) {
                  this.set_applet_icon_name("arch-uptodate-symbolic");
                  this._applet_label.hide();

                  this.menuExpander.label.set_text('Up to date :)');
                  this.menuExpander.actor.reactive = false;
                  this.menuExpander._triangle.visible = false;
              } else {
                  this.set_applet_icon_name("arch-updates-symbolic");
                  this.set_applet_label("" + this._updateList.length);

                  this.menuExpander.label.set_text(Gettext.ngettext( "%d update pending", "%d updates pending", this._updateList.length).format(this._updateList.length));
                  this.menuExpander.actor.reactive = true;
                  this.menuExpander._triangle.visible = true;
              }
            break;
          case AUState.Error:
              this.set_applet_icon_name("arch-error-symbolic");
            break;
        }

  //      this._applet_icon.icon_size = this._panelheight - 12;
        this._iState = newState;
      }
        catch (e) {
            global.logError(e);
        }
    },

    // #############################################################
    // periodical check for updates
    // result is put into the special sub menu which holds the packet names
    _timerCheckForUpdate: function(bDoChecking) {
                if (bDoChecking && this._iState != AUState.Checking) {
                  this._doCheckForUpdateCommand();
                }

                if (this._TimerID > 0) {
                        Mainloop.source_remove(this._TimerID);
                }
//                global.logError("restart time to " + this.pref_checkinterval * 60);
                this._TimerID = Mainloop.timeout_add_seconds(this.pref_checkinterval * 60, () => {
                              this._timerCheckForUpdate(true);
                              return true;
                            });
    },

    // #############################################################
    // ### initiate the check command
    // ###
    // #############################################################
    _doUpdateCommand () {
      try{
            Util.spawnCommandLine(this.pref_updatecmd);
	} catch (err) {
            global.logError(err); }
    },

    // #############################################################
    // ### initiate the check command
    // ###
    // #############################################################
    _doCheckForUpdateCommand () {
//                global.logError("_checkUpdates start");
                if(this._updateProcess_sourceId) {
                        // A check is already running ! Maybe we should kill it and run another one ?
                        return;
                }
                // Run asynchronously, to avoid  shell freeze - even for a 1s check
//                global.logError("_checkUpdates 1");
                try {
                        // Parse check command line 
                        let [parseok, argvp] = GLib.shell_parse_argv( this.pref_checkcmd );
                        if (!parseok) { throw 'Parse error' };
                        let [res, pid, in_fd, out_fd, err_fd]  = GLib.spawn_async_with_pipes(null, argvp, null, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
                        // Let's buffer the command's output - that's a input for us !
                        this.res = res;
                        this._updateProcess_stream = new Gio.DataInputStream({
                                base_stream: new Gio.UnixInputStream({fd: out_fd})
                        });
//                        global.logError("_checkUpdates 2");

                        // #################################################
                        // We will process the output at once when it's done
                        this._updateProcess_sourceId = GLib.child_watch_add(0, pid, Lang.bind(this, function() {this._checkUpdatesRead()}));
                        this._updateProcess_pid = pid;
                        this._setState(AUState.Checking)

                 } catch (err) {
                        global.logError(err);
                        this.lastUnknowErrorString = err.message.toString();
                        this._setState(AUState.Error)
                 }
//        global.logError("_checkUpdates end");
    },

    // #############################################################
    // ### got an answer from check command
    // #############################################################
    _checkUpdatesRead () {
                // Read the buffered output
//                global.logError("_checkUpdatesRead");
                let updateList = [];
                let out, size;
                do {
                        [out, size] = this._updateProcess_stream.read_line_utf8(null);
                        if (out) updateList.push(out);
                } while (out);
                // If version numbers should be stripped, do it
                if (this.pref_stripversions == true) {
                        updateList = updateList.map(function(p) {
                                // Try to keep only what's before the first space
                                var chunks = p.split(" ",2);
                                return chunks[0];
                        });
                }
                this._updateList = updateList;
                try{
                  this.updatesListMenuLabel.set_text(updateList.join("\n"));}
                catch (err) {
                        global.logError(err);}


                this._setState(AUState.CheckResult);


                // Free resources
                this._updateProcess_stream.close(null);
                this._updateProcess_stream = null;
                GLib.source_remove(this._updateProcess_sourceId);
                this._updateProcess_sourceId = null;
                this._updateProcess_pid = null;

//                global.logError("_checkUpdatesRead end");
    },

    // #############################################################
    // #############################################################
    _startFolderMonitor: function() {
            if (this.pref_pacmandir) {
                    this.monitor_dir = Gio.file_new_for_path(this.pref_pacmandir);
                    this.monitor = this.monitor_dir.monitor_directory(0, null);
                    this.monitor.connect('changed', Lang.bind(this, this._onFolderChanged));
            }
    },
    // #############################################################
    // #############################################################
    _onFolderChanged: function() {
            // Folder have changed ! Let's schedule a check in a few seconds
            let that = this;
            if (this._TimerID > 0) {
                        Mainloop.source_remove(this._TimerID);
            }
//            global.logError("restart time to " + this.pref_checkinterval * 60);
            this._TimerID = Mainloop.timeout_add_seconds(5, () => {
                              that._timerCheckForUpdate(true);
                              return true;
                            });
    },

    // #############################################################
    // #############################################################
    _onMenuOpened: function() {
            // This event is fired when menu is shown or hidden
            // Only open the submenu if the menu is being opened and there is something to show
            this._checkAutoExpandList();
    },

    // #############################################################
    // #############################################################
    _checkAutoExpandList: function() {
        try{
            if (this.menu.isOpen && this._updateList.length > 0 && this._updateList.length <= this.pref_maxitemstoshow) {
               this.menuExpander.menu.open(false);
            } else {
               this.menuExpander.menu.close(false);
            }
        }
        catch (err) {
                global.logError(err);}
    },


    // #############################################################
    // #############################################################
    on_settings_changed: function() {
        try{
//            global.logError("on_settings_changed " + this._iState + " " + AUState.Start);
            if (this._iState != AUState.Start) {
                this._timerCheckForUpdate(false);
            }
        }
        catch (err) {
                global.logError(err);}
    },


    // #############################################################
    // the applet was selected
    on_applet_clicked(event) {
                this.menu.toggle();
    },

    // #############################################################
    // an applet restart/removement
    // make sure to disable all running timers
    on_applet_removed_from_panel() {
      if (this._TimerID > 0) {
        Mainloop.source_remove(this._TimerID);
      }
      this._updateProcess_sourceId = null;
      this._updateProcess_pid = null;

   }
}

function main(metadata, orientation, panelHeight, instanceId) {
    let myApplet = new MyApplet(orientation, panelHeight, instanceId);
    return myApplet;
}
