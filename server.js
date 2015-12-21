// set variables for environment
var express = require('express'),
	app     = express(),
	path    = require('path'),
	mysql   = require('mysql');
	request = require('request'),
	fs      = require('fs'),
	crypto  = require('crypto'),
	yauzl   = require("yauzl");

// Set server port
app.listen(4000);
console.log('server is running');

var pool = mysql.createPool({
	connectionLimit : 10,
	host     : 'localhost',
	user     : 'checksums',
	password : 'password',
	database : 'checksums'
});

pool.on('enqueue', function () {
	log_error('Waiting for available connection slot');
});

var queue = new queue();

app.get( '/plugin/:slug', function(req, res) {
	if ( ! req.query.version ) {
		return res.status(400).json({
			'error': 'No version specified'
		});
	}

	if ( ! queue.add( 'plugin', req.params.slug, req.query.version, res ) ) {
		return res.status(202).json({
			'error': 'Generating checksums'
		});
	}
});

app.get( '/theme/:slug', function(req, res) {
	if ( ! queue.add( 'theme', req.params.slug, req.query.version, res ) ) {
		return res.status(202).json({
			'error': 'Generating checksums'
		});
	}
});

app.use(function(req, res, next) {
	res.status(404).json({
		'error': "Route doesn;'t exist"
	});
});


function log_error(msg) {
	console.log(msg);
}

function queue() {
	var self   = this
	var items  = new Array();
	var runner = false;

	this.add = function( object, slug, version, res ) {
		if ( this.exists( object, slug, version ) ) {
			return false;
		}

		var collector = new Collector( object, slug, version );

		collector.get_checksums( function(obj) {
			if ( res ) {
				if ( obj.hasOwnProperty('error') ) {
					if ( obj.error == 'Generating checksums' ) {
						items[ object + ' ' + slug + ' ' + version ] = collector;

						if ( ! runner ) {
							self.run( collector );
						}

						return res.status(202).json(obj);
					}
					else {
						return res.status(500).json(obj);
					}
				}
				else {
					res.json(obj);
				}
			}
		});

		return true;
	}

	this.exists = function( object, slug, version ) {
		if ( object + ' ' + slug + ' ' + version in items ) {
			return true;
		}

		return false;
	}

	this.run = function( collector ) {
		runner = collector;

		console.log( 'Run: ' + collector.object + ' ' + collector.slug + ' ' + collector.version );

		collector.run();
	}

	this.next = function() {
		delete items[ runner.object + ' ' + runner.slug + ' ' + runner.version ];

		if ( Object.keys(items).length > 0 ) {
			this.run( items[ Object.keys(items)[0] ] );
		}
		else {
			runner = false;
		}
	}

}


function Collector( object, slug, version ) {
	var self = this;

	this.object_id = false;
	this.object    = object;
	this.slug      = slug;
	this.version   = version;

	this.get_checksums = function( callback ) {
		pool.getConnection(function(err, connection) {
			var sql     = "SELECT * FROM objects WHERE type = ? AND slug = ? AND version = ?";
			var inserts = [ object, slug, version ];
			sql         = mysql.format(sql, inserts);

			connection.query( sql, function(err, rows, fields) {
				if ( ! err ) {
					if ( rows.length > 0 ) {
						if ( rows[0].status == 'ok' ) {
							connection.query( "SELECT file, md5 as checksum FROM checksums WHERE object_id = " + rows[0].id, function(err, rows, fields) {
								connection.release();

								callback({
									'checksums': rows
								})
							});
						}
						else {
							connection.release();

							callback({
								'error': rows[0].status
							});
						}
					}
					else {
						connection.release();

						callback({
							'error': 'Generating checksums'
						});
					}
				}
				else {
					log_error('Database is down');

					callback({
						'error': 'Database is down'
					});

					connection.release();
				}
			});
		});
	}

	this.run = function() {
		this.download_zip();
	}

	this.download_zip = function() {
		pool.getConnection(function(err, connection) {
			var arr = {
				type: object,
				slug: slug,
				version: version,
				status: 'generating'
			}

			connection.query('INSERT INTO objects SET datetime = NOW(), ?', arr, function(err, result) {
				if ( ! err ) {
					self.object_id = parseInt(result.insertId);
					
					var url  = 'https://downloads.wordpress.org/';
					var file = object + '/' + slug + '.' + version + '.zip';
					var r    = request( url + file + '?nostats=1' );

					r.on('response', function (resp) {
						if ( resp.statusCode === 200 ) {
							r.pipe( fs.createWriteStream(file) ).on('close', function () {
								self.read_zip( file );
							});
							connection.release();
						} else {
							log_error( object + " " + slug + " (" + version + ") doesn't exist");

							connection.query( "UPDATE objects SET status = 'error' WHERE id = " +  self.object_id, function(err) {
								connection.release();

								queue.next();
							});
						}
					});
				}
				else {
					log_error("Could't insert object: " + object + " - " + slug + " - " + version );
					queue.next();
					connection.release();
				}
			});
		});
	}

	this.read_zip = function( path ) {
		yauzl.open(path, function(err, zipfile) {
			if (err) {
				log_error( "Couldn't open the zip file: " + path );
				queue.next();
				return;
			}

			var checksums = [];

			zipfile.on("entry", function(entry) {
				if (/\/$/.test(entry.fileName)) {
					// directory file names end with '/'
					return;
				}

				zipfile.openReadStream(entry, function(err, readStream) {
					if (err) {
						log_error( "Couldn't read the file (" + entry.fileName + ") in zip: " + path );
						return;
					}

					var hash_md5 = crypto.createHash('md5');
					var hash_sha1 = crypto.createHash('sha1');

					readStream.on('data', function (data) {
						hash_md5.update(data, 'utf8');
						hash_sha1.update(data, 'utf8');
					})

					readStream.on('end', function () {
						checksums.push( [ self.object_id, entry.fileName.slice(slug.length + 1), hash_md5.digest('hex'), hash_sha1.digest('hex') ] );
					})
				});
			});

			zipfile.on("end", function() {
				fs.unlinkSync(path);

				self.store_checksums( checksums );
			});
		});
	}

	this.store_checksums = function(checksums) {
		var sql = "INSERT INTO checksums (object_id, file, md5, sha1) VALUES ?";

		pool.getConnection(function(err, connection) {
			connection.query(sql, [checksums], function(err) {
				if ( ! err ) {
					connection.query( "UPDATE objects SET status = 'ok' WHERE id = " +  self.object_id, function(err) {
						connection.release();

						queue.next();
					});
				}
				else {
					log_error( 'Failed: Marking object ' + self.object_id + ' to status ok' );

					connection.release();

					queue.next();
				}
			});
		});
	}

}
