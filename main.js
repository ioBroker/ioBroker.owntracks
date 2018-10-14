/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';
var utils   = require(__dirname + '/lib/utils'); // Get common adapter utils
var adapter = utils.Adapter('owntracks');
//var LE      = require(utils.controllerDir + '/lib/letsencrypt.js');
var createStreamServer = require('create-stream-server');
var mqtt = require('mqtt-connection');
var sodium = require('libsodium-wrappers');

var server;
var clients = {};
var namespaces = {users: {}, locations: {}};

function decrypt(key, value) {
    var result = '';
    for (var i = 0; i < value.length; ++i) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function (callback) {
    try {
        adapter.log.info('cleaned everything up...');
        if (server) {
            server.destroy();
            server = null;
        }
        callback();
    } catch (e) {
        callback();
    }
});

adapter.on('ready', main);

/*
 *
 */
function createLocation(id, name) {
    var id = adapter.namespace + '.locations.' + id;
    adapter.getForeignObject(id + '.users',   function (err, obj) {
        if (!obj) {
            adapter.setForeignObject(id + '.users', {
                common: {
                    name:   'Present users in location ' + name,
                    role:   'state',
                    type:   'string'
                },
                type: 'state',
                native: {}
            });
        }
    });
}

/*
 *
 */
function createUser(user) {
    var id = adapter.namespace + '.users.' + user.replace(/\s|\./g, '_');
    adapter.getForeignObject(id + '.battery',   function (err, obj) {
        if (!obj) {
            adapter.setForeignObject(id + '.battery', {
                common: {
                    name:   'Device battery level for ' + user,
                    min:    0,
                    max:    100,
                    unit:   '%',
                    role:   'battery',
                    type:   'number'
                },
                type: 'state',
                native: {}
            });
        }
    });
    adapter.getForeignObject(id + '.latitude',  function (err, obj) {
        if (!obj) {
            adapter.setForeignObject(id + '.latitude', {
                common: {
                    name:   'Latitude for ' + user,
                    role:   'gps.latitude',
                    type:   'number'
                },
                type: 'state',
                native: {}
            });
        }
    });
    adapter.getForeignObject(id + '.longitude', function (err, obj) {
        if (!obj) {
            adapter.setForeignObject(id + '.longitude', {
                common: {
                    name:   'Longitude for ' + user,
                    role:   'gps.longitude',
                    type:   'number'
                },
                type: 'state',
                native: {}
            });
        }
    });
    adapter.getForeignObject(id + '.location.name',  function (err, obj) {
        if (!obj) {
            adapter.setForeignObject(id + '.location.name', {
                common: {
                    name:   'Location of the ' + user,
                    role:   'state',
                    type:   'string'
                },
                type: 'state',
                native: {}
            });
        }
    });
    adapter.getForeignObject(id + '.location.entered',  function (err, obj) {
        if (!obj) {
            adapter.setForeignObject(id + '.location.entered', {
                common: {
                    name:   'Timestamp the user has entered the location',
                    role:   'state',
                    type:   'number'
                },
                type: 'state',
                native: {}
            });
        }
    });
    adapter.getForeignObject(id + '.accuracy',  function (err, obj) {
        if (!obj) {
            adapter.setForeignObject(id + '.accuracy', {
                common: {
                    name:   'Accuracy for ' + user,
                    role:   'state',
                    unit:   'm',
                    type:   'number'
                },
                type: 'state',
                native: {}
            });
        }
    });
    adapter.getForeignObject(id + '.encryption',  function (err, obj) {
        if (!obj) {
            adapter.setForeignObject(id + '.encryption', {
                common: {
                    name:   'Encryption for ' + user,
                    role:   'state',
                    type:   'boolean'
                },
                type: 'state',
                native: {}
            });
        }
    });
    adapter.getForeignObject(id + '.timestamp',  function (err, obj) {                    
        if (!obj) {                                                                      
            adapter.setForeignObject(id + '.timestamp', {                 
                common: {                                                
                    name:   'Timestamp for ' + user,                     
                    role:   'state',                                     
                    type:   'number'                                     
                },                                                       
                type: 'state',                                           
                native: {}                                               
            });                                                          
        }                                                                
    });                              
    adapter.getForeignObject(id + '.datetime',  function (err, obj) {                   
        if (!obj) {                                                                      
            adapter.setForeignObject(id + '.datetime', {                                
                common: {                                                
                    name:   'Datetime for ' + user,                     
                    role:   'state',                                  
                    type:   'string'                                     
                },                                                       
                type: 'state',                                           
                native: {}                                               
            });                                                          
        }                                                                
    });                        
}

function sendState2Client(client, topic, payload) {
    // client has subscription for this ID
    if (client._subsID && client._subsID[topic]) {
        client.publish({topic: topic, payload: payload});
    } else
    //  Check patterns
    if (client._subs) {
        for (var s in client._subs) {
            if (!client._subs.hasOwnProperty(s)) continue;
            if (client._subs[s].regex.exec(topic)) {
                client.publish({topic: topic, payload: payload});
                break;
            }
        }
    }
}

function processTopic(topic, payload, ignoreClient) {
    for (var k in clients) {
        // if get and set have different topic names, send state to issuing client too.
        if (clients[k] === ignoreClient) continue;
        sendState2Client(clients[k], topic, payload);
    }
}

var cltFunction = function (client) {
    client.on('connect', function (packet) {
        client.id = packet.clientId;
        if (adapter.config.user) {
            if (adapter.config.user != packet.username ||
                adapter.config.pass != packet.password) {
                adapter.log.warn('Client [' + packet.clientId + '] has invalid password(' + packet.password + ') or username(' + packet.username + ')');
                client.connack({returnCode: 4});
                if (clients[client.id]) delete clients[client.id];
                client.stream.end();
                return;
            }
        }

        adapter.log.info('Client [' + packet.clientId + '] connected');
        client.connack({returnCode: 0});
        clients[client.id] = client;
    });

    client.on('publish', function (packet) {
        var isAck = true;
        var topic   = packet.topic;
        var message = packet.payload;
        adapter.log.debug('publish "' + topic + '": ' + message);

        if (packet.qos == 1) {
            client.puback({ messageId: packet.messageId});
        }
        else if (packet.qos == 2) {
            client.pubrec({ messageId: packet.messageId});
        }
        // "owntracks/iobroker/klte":
        // {
        //      "_type":"location", // location, lwt, transition, configuration, beacon, cmd, steps, card, waypoint
        //      "acc":50,           // accuracy of location in meters
        //      "batt":46,          // is the device's battery level in percent (integer)
        //      "lat":49.0026446,   // latitude
        //      "lon":8.3832128,    // longitude
        //      "tid":"te",         // is a configurable tracker-ID - ignored
        //      "tst":1472987109    // UNIX timestamp in seconds
        // }
        var parts = topic.split('/');
        if (parts[1] !== adapter.config.user) {
            adapter.log.warn('publish "' + topic + '": invalid user name - "' + parts[1] + '"');
            return;
        }
	
	// create user node / namespace
        if (!namespaces.users[parts[2]]) {
            createUser(parts[2]);
            namespaces.users[parts[2]] = true;
        }
        processTopic(topic, message);
	    
	try
	{
		// https://owntracks.org/booklet/tech/json/
		//
		// format without encryption key
		//  {"_type":"location","tid":"XX","acc":00,"batt":00,"conn":"w","lat":00.0000000,"lon":00.0000000,"t":"u","tst":0000000000}
		//
		// format WITH encryption key
		// {"_type":"encrypted","data":"..."}
		//
		var obj = JSON.parse(message);
		obj.encryption = false;
		var decrypted = false;
		
		// TYPE: encrypted
		// decrypt message.data using adapter.config.encryptionKey
		if (obj._type === 'encrypted')
		{
			// no key set
			if (!adapter.config.encryptionKey)
				adapter.log.warn('No encryption key defined in settings! Please go to settings and set a key!');
			
			else
			{
				var cypherText = new Buffer(obj.data, 'base64');
				var cipher = null;
				var nonce = cypherText.slice(0,24);
				var key = new Buffer(32);
				key.fill(0);
				key.write(adapter.config.encryptionKey);
				
				// try to encrypt message and catch error in case key is wrong
				try
				{
					cipher = sodium.crypto_secretbox_open_easy(cypherText.slice(24), nonce, key, "text");
					decrypted = true;
				}
				catch(e) {adapter.log.warn(e)}
				
				obj = JSON.parse(cipher);
				obj.encryption = true;
			}

		}
		
		// log
		adapter.log.info('Received '+(obj.encryption ? 'encrypted' : 'unencrypted')+' payload: '+JSON.stringify(obj));
		
		// TYPE: transition
		// User has entered or left a region
		if (obj._type === 'transition')
		{
			var location = obj.desc.replace(/\s|\./g, '_').toLowerCase();
			
			// create location node in case of new location
			if (!namespaces.locations[location]) {
				createLocation(location, obj.desc);
				namespaces.locations[location] = true;
			}
			
			// user has entered location
			if (obj.event === 'enter')
			{
				// update user
				adapter.setState('users.' + parts[2] + '.location.name',  {val: obj.desc,  ts: obj.tst * 1000, ack: true});
				adapter.setState('users.' + parts[2] + '.location.entered',  {val: obj.tst,  ts: obj.tst * 1000, ack: true});
				
				// update location (add user if not present yet for some reason)
				var users = adapter.getState('locations.' + location + '.users').val;
				if (users.indexOf(parts[2]) === -1)
					adapter.setState('locations.' + location + '.users',  {val: users + parts[2] + ',',  ts: obj.tst * 1000, ack: true});
			}
			
			// user has left location
			else if (obj.event === 'leave')
			{
				// update user
				adapter.setState('users.' + parts[2] + '.location.name',  {val: '',  ts: obj.tst * 1000, ack: true});
				adapter.setState('users.' + parts[2] + '.location.entered',  {val: '',  ts: obj.tst * 1000, ack: true});
				
				// update location (remove user if present)
				var users = adapter.getState('locations.' + location + '.users').val;
				if (users.indexOf(parts[2]) > -1)
					adapter.setState('locations.' + location + '.users',  {val: users.replace(parts[2] + ',', ''),  ts: obj.tst * 1000, ack: true});
			}
		}
		
		// TYPE: location
		// message sent unencrypted or has been decrypted
		if (obj._type === 'location')
		{
			adapter.setState('users.' + parts[2] + '.encryption',  {val: obj.encryption,  ts: obj.tst * 1000, ack: true});
			
			if (obj.acc !== undefined)
				adapter.setState('users.' + parts[2] + '.accuracy',  {val: obj.acc,  ts: obj.tst * 1000, ack: true});
			
			if (obj.batt !== undefined)
				adapter.setState('users.' + parts[2] + '.battery',   {val: obj.batt, ts: obj.tst * 1000, ack: true});
			
			if (obj.lon !== undefined)
				adapter.setState('users.' + parts[2] + '.longitude', {val: obj.lon,  ts: obj.tst * 1000, ack: true});
			
			if (obj.lat !== undefined)
				adapter.setState('users.' + parts[2] + '.latitude',  {val: obj.lat,  ts: obj.tst * 1000, ack: true});
			
			if (obj.tst !== undefined)
			{
				adapter.setState('users.' + parts[2] + '.timestamp', {val: obj.tst,  ts: obj.tst * 1000, ack: true});
				var date    = new Date(obj.tst * 1000);
				var day     = '0' + date.getDate();
				var month   = '0' + (date.getMonth() + 1);
				var year    = date.getFullYear();
				var hours   = '0' + date.getHours();
				var minutes = '0' + date.getMinutes();
				var seconds = '0' + date.getSeconds();
				var formattedTime = day.substr(-2) + '.' + month.substr(-2) + '.' + year + ' ' + hours.substr(-2) + ':' + minutes.substr(-2) + ':' + seconds.substr(-2);
				
				adapter.setState('users.' + parts[2] + '.datetime', {val: formattedTime,  ts: obj.tst * 1000, ack: true});
			}
		}
	}
	catch (e){
		adapter.log.error('Cannot parse payload: ' + message);
	}
	    
    });

    client.on('subscribe', function (packet) {
        var granted = [];
        if (!client._subsID) client._subsID = {};
        if (!client._subs)   client._subs = {};

        for (var i = 0; i < packet.subscriptions.length; i++) {
            granted.push(packet.subscriptions[i].qos);

            var topic  = packet.subscriptions[i].topic;

            adapter.log.debug('Subscribe on ' + topic);
            // if pattern without wildchars
            if (topic.indexOf('*') === -1 && topic.indexOf('#') === -1 && topic.indexOf('+') === -1) {
                client._subsID[topic] = {
                    qos: packet.subscriptions[i].qos
                };
            } else {
                // "owntracks/+/+/info" => owntracks\/.+\/.+\/info
                var pattern = topic.replace(/\//g, '\\/').replace(/\+/g, '[^\\/]+').replace(/\*/g, '.*');
                pattern = '^' + pattern + '$';

                // add simple pattern
                client._subs[topic] = {
                    regex:   new RegExp(pattern),
                    qos:     packet.subscriptions[i].qos,
                    pattern: topic
                };
            }
        }

        client.suback({granted: granted, messageId: packet.messageId});
        //Subscribe on owntracks/+/+
        //Subscribe on owntracks/+/+/info
        //Subscribe on owntracks/iobroker/denis/cmd
        //Subscribe on owntracks/+/+/event
        //Subscribe on owntracks/+/+/waypoint

        // send to client all images
        if (adapter.config.pictures && adapter.config.pictures.length) {
            setTimeout(function () {
                for (var p = 0; p < adapter.config.pictures.length; p++) {
                    var text = adapter.config.pictures[p].base64.split(',')[1]; // string has form data:;base64,TEXT==
                    sendState2Client(client, 'owntracks/' + adapter.config.user + '/' + adapter.config.pictures[p].name + '/info',
                        JSON.stringify({
                            _type: 'card',
                            name: adapter.config.pictures[p].name,
                            face: text
                        })
                    );
                }
            }, 200);
        }
    });

    client.on('pingreq', function (packet) {
        adapter.log.debug('Client [' + client.id + '] pingreq');
        client.pingresp();
    });

    client.on('disconnect', function (packet) {
        adapter.log.info('Client [' + client.id + '] disconnected');
        client.stream.end();
    });

    client.on('close', function (err) {
        adapter.log.info('Client [' + client.id + '] closed');
        delete clients[client.id];
    });

    client.on('error', function (err) {
        adapter.log.warn('[' + client.id + '] ' + err);
    });
};


function initMqttServer(config) {
    var serverConfig = {};
    var options = {
        ssl:        config.certificates,
        emitEvents: true // default
    };

    config.port = parseInt(config.port, 10) || 1883;

    if (config.ssl) {
        serverConfig.mqtts = 'ssl://0.0.0.0:' + config.port;
        if (config.webSocket) {
            serverConfig.mqtwss = 'wss://0.0.0.0:'  + (config.port + 1);
        }
    } else {
        serverConfig.mqtts = 'tcp://0.0.0.0:' + config.port;
        if (config.webSocket) {
            serverConfig.mqtwss = 'ws://0.0.0.0:'  + (config.port + 1);
        }
    }

    server = createStreamServer(serverConfig, options, function (clientStream) {
        cltFunction(mqtt(clientStream, {
            notData: !options.emitEvents
        }));
    });

    // to start
    server.listen(function () {
        if (config.ssl) {
            adapter.log.info('Starting MQTT (Secure) ' + (config.user ? 'authenticated ' : '') + 'server on port ' + config.port);
            if (config.webSocket) {
                adapter.log.info('Starting MQTT-WebSocket (Secure) ' + (config.user ? 'authenticated ' : '') + 'server on port ' + (config.port + 1));
            }
        } else {
            adapter.log.info('Starting MQTT ' + (config.user ? 'authenticated ' : '') + 'server on port ' + config.port);
            if (config.webSocket) {
                adapter.log.info('Starting MQTT-WebSocket ' + (config.user ? 'authenticated ' : '') + 'server on port ' + (config.port + 1));
            }
        }
    });
}

function main() {
    //noinspection JSUnresolvedVariable
    adapter.config.pass = decrypt('Zgfr56gFe87jJOM', adapter.config.pass);
    adapter.config.encryptionKey = decrypt('Zgfr56gFe87jJOM', adapter.config.encryptionKey);

    if (!adapter.config.user) {
        adapter.log.error('Empty user name not allowed!');
        process.stop(-1);
        return;
    }

    if (adapter.config.secure) {
        // Load certificates
        adapter.getCertificates(function (err, certificates, leConfig) {
            adapter.config.certificates = certificates;
            adapter.config.leConfig     = leConfig;
            initMqttServer(adapter.config);
        });
    } else {
        initMqttServer(adapter.config);
    }
}
