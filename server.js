var mineos = require('./mineos');
var async = require('async');
var chokidar = require('chokidar');
var path = require('path');
var events = require('events');
var introspect = require('introspect');
var tail = require('tail').Tail;
var uuid = require('node-uuid');
var os = require('os');
var CronJob = require('cron').CronJob;
var server = exports;

server.backend = function(base_dir, socket_emitter, dir_owner) {
  var self = this;

  self.servers = {}
  self.front_end = socket_emitter || new events.EventEmitter();

  (function() {
    var server_path = path.join(base_dir, mineos.DIRS['servers']);
    var regex_servers = new RegExp('{0}\/[a-zA-Z0-9_\.]+\/.+'.format(server_path));
    self.watcher = chokidar.watch(server_path, { persistent: true, ignored: regex_servers });
    // ignores event updates from servers that have more path beyond the /servers/<dirhere>/<filehere>

    self.watcher
      .on('addDir', function(dirpath) {
        // event to trigger when new server detected, e.g., /var/games/minecraft/servers/<newdirhere>
        try {
          var server_name = mineos.extract_server_name(base_dir, dirpath);
        } catch (e) { return }
        if (server_name == path.basename(dirpath)) 
          track_server(server_name);
      })
      .on('unlinkDir', function(dirpath) {
        // event to trigger when server directory deleted
        try {
          var server_name = mineos.extract_server_name(base_dir, dirpath);
        } catch (e) { return }
        if (server_name == path.basename(dirpath))
          self.untrack_server(server_name);
      })
  })();

  function host_heartbeat() {
    self.front_end.emit('host_heartbeat', {
      'uptime': os.uptime(),
      'freemem': os.freemem(),
      'loadavg': os.loadavg()
    })
  }

  setInterval(host_heartbeat, 1000);

  function track_server(server_name) {
    /* when evoked, creates a permanent 'mc' instance, namespace, and place for file tails/watches. 
       track_server should only happen in response to the above chokidar watcher.
    */
    var instance = new mineos.mc(server_name, base_dir),
        nsp;

    function setup() {
      var HEARTBEAT_INTERVAL_MS = 5000;
      nsp = self.front_end.of('/{0}'.format(server_name));

      self.servers[server_name] = {
        instance: instance,
        nsp: nsp,
        tails: {},
        watches: {},
        notices: [],
        cron: []
      }

      async.forever(
        function(next) {
          async.series({
            'up': function(cb) {
              instance.property('up', function(err, is_up) {
                cb(null, is_up);
              })
            },
            'memory': function(cb) {
              instance.property('memory', function(err, mem_info) {
                cb(null, err ? {} : mem_info);
              })
            },
            'ping': function(cb) {
              instance.property('ping', function(err, ping_info) {
                cb(null, err ? {} : ping_info);
              })
            }
          }, function(err, retval) {
            if (server_name in self.servers) {
              nsp.emit('heartbeat', {
                'server_name': server_name,
                'timestamp': Date.now(),
                'payload': retval
              })
              //console.log('[{0}] Heartbeat transmitted.'.format(server_name))
              setTimeout(next, HEARTBEAT_INTERVAL_MS);
            }
            else {
              next(true);
            }
          })
        },
        function(err) {
          console.log('[{0}] Heartbeats ceased.'.format(server_name))
        }
      )

      console.info('Discovered server: {0}'.format(server_name));
      self.front_end.emit('track_server', server_name);
      make_tail('logs/latest.log');
      make_watch('server.properties', function() {
        instance.sp(function(err, sp_data) {
          nsp.emit('result', {'server_name': server_name, 'property': 'server.properties', 'payload': sp_data});
        })
      });

      nsp.on('connection', function(socket) {
        var ip_address = socket.request.connection.remoteAddress;

        function produce_receipt(args) {
          /* when a command is received, immediately respond to client it has been received */
          console.info('[{0}] {1} issued command : "{2}"'.format(server_name, ip_address, args.command))
          args.uuid = uuid.v1();
          args.time_initiated = Date.now();
          nsp.emit('server_ack', args)
          server_dispatcher(args);
        }

        function start_watch(opts) {
          /* can put a tail/watch on any file, and joins a room for all future communication */
          var rel_filepath = opts.filepath;

          if (rel_filepath in self.servers[server_name].tails) {
            var fs = require('fs');
            var abs_filepath = path.join(self.servers[server_name].instance.env['cwd'], rel_filepath);

            if (opts.from_start) {
              fs.readFile(abs_filepath, function (err, data) {
                if (!err) {
                  console.info('[{0}] {1} transmittting existing file contents: {2} ({3} bytes)'.format(server_name, ip_address, rel_filepath, data.length));
                  nsp.emit('file head', {filename: rel_filepath, payload: data.toString()});
                }
                socket.join(rel_filepath);
              });
            } else {
              socket.join(rel_filepath);
            }
            console.info('[{0}] {1} requesting tail: {2}'.format(server_name, ip_address, rel_filepath));
          } else if (rel_filepath in self.servers[server_name].watches) {
            socket.join(rel_filepath);
            console.info('[{0}] {1} watching file: {2}'.format(server_name, ip_address, rel_filepath));
          } else {
            console.error('[{0}] {1} requesting tail: {2} (failed: not yet created)'.format(server_name, ip_address, rel_filepath));
          }
        }

        function unwatch(rel_filepath) {
          /* removes a tail/watch for a given file, and leaves the room */
          if (rel_filepath in self.servers[server_name].tails) {
            socket.leave(rel_filepath);
            console.info('[{0}] {1} dropping tail: {2}'.format(server_name, ip_address, rel_filepath));
          } else if (rel_filepath in self.servers[server_name].watches) {
            socket.leave(rel_filepath);
            console.info('[{0}] {1} stopped watching file: {1}'.format(server_name, ip_address, rel_filepath));
          } else {
            //console.error('[{0}] no existing room found for {1}'.format(server_name, rel_filepath));
          }
        }

        function get_prop(requested) {
          console.info('[{0}] {1} requesting property: {2}'.format(server_name, ip_address, requested.property));
          instance.property(requested.property, function(err, retval) {
            console.info('[{0}] returned to {1}: {2}'.format(server_name, ip_address, retval));
            nsp.emit('server_fin', {'server_name': server_name, 'property': requested.property, 'payload': retval});
          })
        }

        function get_page_data(page) {
          switch (page) {
            case 'glance':
              console.info('[{0}] {1} requesting server at a glance info'.format(server_name, ip_address));

              async.parallel({
                'increments': async.apply(instance.list_increments),
                'archives': async.apply(instance.list_archives),
                'du_awd': async.apply(instance.property, 'du_awd'),
                'du_bwd': async.apply(instance.property, 'du_bwd'),
                'du_cwd': async.apply(instance.property, 'du_cwd'),
                'owner': async.apply(instance.property, 'owner')
              }, function(err, results) {
                nsp.emit('page_data', {page: page, payload: results});
              })
              break;
            default:
              nsp.emit('page_data', {page: page});
              break;
          }
        }

        function manage_cron(opts) {
          function emit_cronjobs() {
            var crontabs = self.servers[server_name].cron;
            var retval = [];
            for (var i=0; i < crontabs.length; i++)
              retval.push(crontabs[i].opts);

            nsp.emit('page_data', {
              page: 'cron',
              payload: retval
            });
          }
          
          switch (opts.operation) {
            case 'enable_cron':
              console.log('[{0}] {1} requests cron addition: "{2}" -> {3}'.format(server_name, ip_address, opts.source, opts.command));
              console.log('Adding cronjob', opts);
              var cronjob = new CronJob(opts.source, function (){
                opts['suppress_popup'] = true;
                server_dispatcher(opts);
              }, null, false);

              cronjob['opts'] = opts;
              self.servers[server_name].cron.push(cronjob);
              cronjob.start();
              emit_cronjobs();
              break;
            case 'disable_cron':
              console.log('[{0}] {1} requests cron deletion: "{2}" -> {3}'.format(server_name, ip_address, opts.source, opts.command));
              var crontabs = self.servers[server_name].cron;
              for (var i = crontabs.length-1; i >= 0; i--)
                if (crontabs[i].cronTime.source == opts.source &&
                    crontabs[i].opts.command == opts.command) {
                  console.log('Removing cronjob: "{0}" -> {1}'.format(opts.source, opts.command));
                  crontabs[i].stop();
                  crontabs.splice(i, 1);
                }
              emit_cronjobs();
              break;
            default:
              emit_cronjobs();
              break;
          }
        }

        console.info('[{0}] {1} connected to namespace'.format(server_name, ip_address));
        socket.on('command', produce_receipt);
        socket.on('property', get_prop);
        socket.on('page_data', get_page_data);
        socket.on('watch', start_watch);
        socket.on('cron', manage_cron);
        console.info('[{0}] broadcasting {1} previous notices'.format(server_name, self.servers[server_name].notices.length));
        nsp.emit('notices', self.servers[server_name].notices);
      })
    }

    function server_dispatcher(args) {
      var fn, required_args;
      var arg_array = [];

      try {
        fn = instance[args.command];
        required_args = introspect(fn);
        // receives an array of all expected arguments, using introspection.
        // they are in order as listed by the function definition, which makes iteration possible.
      } catch (e) { 
        args.success = false;
        args.error = e;
        args.time_resolved = Date.now();
        nsp.emit('server_fin', args);
        console.error('server_fin', args);
        self.servers[server_name].notices.push(args);
        return;
      }

      for (var i in required_args) {
        // all callbacks expected to follow the pattern (success, payload).
        if (required_args[i] == 'callback') 
          arg_array.push(function(err, payload) {
            args.success = !err;
            args.err = err;
            args.time_resolved = Date.now();
            nsp.emit('server_fin', args);
            console.log('server_fin', args)
            
            if (args.command != 'delete')
              self.servers[server_name].notices.push(args);
          })
        else if (required_args[i] in args) {
          arg_array.push(args[required_args[i]])
        } else {
          args.success = false;
          console.error('Provided values missing required argument', required_args[i]);
          args.error = 'Provided values missing required argument: {0}'.format(required_args[i]);
          nsp.emit('server_fin', args);
          return;
        }
      }

      if (args.command == 'delete' && server_name in self.servers) {
        for (var t in self.servers[server_name].tails) 
          self.servers[server_name].tails[t].unwatch();

        for (var w in self.servers[server_name].watches) 
          self.servers[server_name].watches[w].close();
      }

      console.info('[{0}] received request "{1}"'.format(server_name, args.command))
      fn.apply(instance, arg_array);
    }

    function make_tail(rel_filepath) {
      /* makes a file tail relative to the CWD, e.g., /var/games/minecraft/servers/myserver.

         tails are used to get live-event reads on files.

         if the server does not exist, a watch is made in the interim, waiting for its creation.  
         once the watch is satisfied, the watch is closed and a tail is finally created.
      */
      var abs_filepath = path.join(instance.env.cwd, rel_filepath);

      if (rel_filepath in self.servers[server_name].tails) {
        console.warn('[{0}] Tail already exists for {1}'.format(server_name, rel_filepath));
        return;
      }

      try {
        var new_tail = new tail(abs_filepath);
        console.info('[{0}] Created tail on {1}'.format(server_name, rel_filepath));
        new_tail.on('line', function(data) {
          //console.info('[{0}] {1}: transmitting new tail data'.format(server_name, rel_filepath));
          nsp.emit('tail_data', {'filepath': rel_filepath, 'payload': data});
        })
        self.servers[server_name].tails[rel_filepath] = new_tail;
      } catch (e) {
        console.error('[{0}] Create tail on {1} failed'.format(server_name, rel_filepath));
        console.info('[{0}] Watching for file generation: {1}'.format(server_name, rel_filepath));

        var tail_lookout = chokidar.watch(instance.env.cwd, {persistent: true, ignoreInitial: true});
        tail_lookout
          .on('add', function(fp) {
            var file = path.basename(fp);
            if (path.basename(rel_filepath) == file) {
              tail_lookout.close();
              console.info('[{0}] {1} created! Watchfile {2} closed'.format(server_name, file, rel_filepath));
              make_tail(rel_filepath);
            }
          })
      }
    }

    function make_watch(rel_filepath, callback) {
      /* creates a watch for a file relative to the CWD, e.g., /var/games/minecraft/servers/myserver.

         watches are used for detecting file creation and changes.
      */
      var abs_filepath = path.join(instance.env.cwd, rel_filepath);

      if (rel_filepath in self.servers[server_name].watches) {
        console.warn('[{0}] Watch already exists for {1}'.format(server_name, rel_filepath));
        return;
      }

      try {
        var watcher = chokidar.watch(abs_filepath, {persistent: true});
        watcher.on('change', function(fp) {
          callback();
        })
        console.info('[{0}] Started watch on {1}'.format(server_name, rel_filepath));
        self.servers[server_name].watches[rel_filepath] = watcher;
      } catch (e) {
        console.log(e)
        //handle error or ignore
      }

    }

    async.nextTick(setup);

  }

  self.untrack_server = function(server_name) {
    /* closes all watches and tails for a server and 
       deletes the server from the master container self.servers
    */
    var instance = new mineos.mc(server_name, base_dir);

    for (var t in self.servers[server_name].tails) 
      self.servers[server_name].tails[t].unwatch();

    for (var w in self.servers[server_name].watches) 
      self.servers[server_name].watches[w].close();

    self.servers[server_name].nsp.removeAllListeners();
    delete self.servers[server_name];

    self.front_end.emit('untrack_server', server_name);
    console.info('Server removed: {0}'.format(server_name));
  }

  self.shutdown = function() {
    /* cleans up all servers that are open, including all tails and watches */
    self.watcher.close();

    for (var s in self.servers)
      self.untrack_server(s);
  }

  self.webui_dispatcher = function(args) {
    console.info('[WEBUI] Received emit command', args);
    switch (args.command) {
      case 'create':
        if (args.server_name in self.servers) {
          var ERROR = '[{0}] Ignored attempt to create server -- server name already exists.'.format(args.server_name)
          console.error(ERROR);
          self.front_end.emit('error', ERROR);
        } else {
          var instance = new mineos.mc(args.server_name, base_dir);

          async.series([
            async.apply(instance.create, dir_owner),
            async.apply(instance._sp.overlay, args.properties),
          ], function(err, results) {
            if (err) {
              var ERROR = '[{0}] Attempt to create server failed in the backend.'.format(args.server_name);
              console.error(ERROR, err);
              self.front_end.emit('error', ERROR);
            } else {
              console.info('[{0}] Server created in filesystem.'.format(args.server_name))
            }
          })
        }
        break;
      case 'notices':
        for (var server_name in self.servers) 
          self.servers[server_name].nsp.emit('notices', self.servers[server_name].notices);
      default:
        break;
    }
  }

  self.front_end.on('connection', function(socket) {
    console.info('[WEBUI] User connected from', socket.request.connection.remoteAddress);
    self.front_end.emit('server_list', Object.keys(self.servers));
    socket.on('command', self.webui_dispatcher);
  })

  return self;
}