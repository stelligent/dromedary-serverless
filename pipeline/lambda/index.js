'use strict'

var fs       = require('fs');

var AWS      = require('aws-sdk');

var yauzl  = require("yauzl");    // for .zip
var mkdirp = require("mkdirp");   // for .zip
var path   = require("path");     // for .zip

var tar      = require('tar');     // for .tar.gz
var zlib     = require('zlib');    // for .tar.gz
var fstream  = require("fstream"); // for .tar.gz

var childProcess = require('child_process'); // for exec
var querystring  = require('querystring'); // for user parameters
var Promise  = require('promise'); // for sanity!


if(!AWS.config.region) {
    AWS.config.region = process.env.AWS_DEFAULT_REGION;
}
var codepipeline = new AWS.CodePipeline();
var s3 = new AWS.S3({maxRetries: 10, signatureVersion: "v4"});

// run npm
exports.npmHandler = function( event, context ) {
    doAction(npmAction, event, context);
};

// run gulp
exports.gulpHandler = function( event, context ) {
    doAction(gulpAction, event, context);
};

// run an action
function doAction(actionFunction, event, context) {
    console.log(JSON.stringify(event));

    var promise;
    try {
        promise = actionFunction(event["CodePipeline.job"])
    } catch (e) {
        promise = Promise.reject(e);
    }

    handlePromise(promise, event, context);
};

// handle promise by notifying code pipeline
function handlePromise(promise, event, context) {
    promise
    .then(function() {
        console.log("Success!");

        var params = {
            jobId: event["CodePipeline.job"].id
        };
        codepipeline.putJobSuccessResult(params, function(err, data) {
            if(err) {
                context.fail(err);
            } else {
                context.succeed("Action complete.");
            }
        });
    }).catch( function(message) {
        var userParams = querystring.parse( event["CodePipeline.job"].data.actionConfiguration.configuration.UserParameters );
        var retrys = parseInt(userParams['retrys']) || 0
        var continuationToken = parseInt(event["CodePipeline.job"].data.continuationToken) || 0;


        console.log("Prior attempts="+continuationToken+" and retrys="+retrys);
        if(continuationToken < retrys) {
            console.log("Retrying later.");

            var params = {
                jobId: event["CodePipeline.job"].id,
                continuationToken: (continuationToken+1).toString()
            };
            codepipeline.putJobSuccessResult(params, function(err, data) {
                if(err) {
                    context.fail(err);
                } else {
                    context.succeed("Action complete.");
                }
            });

        } else {
            var m = JSON.stringify(message);
            console.error("Failure: "+m);

            var params = {
                jobId: event["CodePipeline.job"].id,
                failureDetails: {
                    message: m,
                    type: 'JobFailed',
                    externalExecutionId: context.invokeid
                }
            };

            codepipeline.putJobFailureResult(params, function(err, data) {
                context.fail(m);
            });
        }
    });

};

// run npm
//
// return: promise
function npmAction(jobDetails) {
    var userParams = querystring.parse( jobDetails.data.actionConfiguration.configuration.UserParameters );
    var artifactName = 'SourceOutput';
    var artifactZipPath = '/tmp/source.zip';
    var artifactExtractPath = '/tmp/source/';

    var outArtifactName = 'SourceInstalledOutput';
    var outArtifactTarballPath = '/tmp/source_installed.tar.gz';

    return downloadInputArtifact(jobDetails, artifactName, artifactZipPath)
        .then(function () {
            return rmdir(artifactExtractPath);
        }).then(function () {
            return extractZip(artifactZipPath, artifactExtractPath);
        }).then(function () {
            return installNpm(artifactExtractPath);
        }).then(function () {
            var subcommand = userParams['subcommand'];
            return runNpm(artifactExtractPath, subcommand);
        }).then(function () {
            return packTarball(artifactExtractPath, outArtifactTarballPath);
        }).then(function () {
            return uploadOutputArtifact(jobDetails, outArtifactName, outArtifactTarballPath);
        });
}


// run gulp
//
// return: promise
function gulpAction(jobDetails) {
    var userParams = querystring.parse( jobDetails.data.actionConfiguration.configuration.UserParameters );
    var artifactName = 'SourceInstalledOutput';
    var artifactZipPath = '/tmp/source_installed.tar.gz';
    var artifactExtractPath = '/tmp/source_installed/';

    return downloadInputArtifact(jobDetails, artifactName, artifactZipPath)
        .then(function () {
            return rmdir(artifactExtractPath);
        }).then(function () {
            return extractTarball(artifactZipPath, artifactExtractPath);
        }).then(function () {
            return installNpm(artifactExtractPath);
        }).then(function () {
            return getJobDetails(jobDetails.id)
        }).then(function (jd) {
            var taskName = userParams['task'];
            return runGulp(artifactExtractPath, taskName, jd.jobDetails.data.pipelineContext.pipelineName);
        });
}


// get codepipeline job details from aws
//
// return: promise
function getJobDetails(jobId) {
    console.log("Getting CodePipeline Job Details  for '"+jobId+"'");
    return new Promise(function (resolve, reject) {
        var params = { jobId: jobId };
        codepipeline.getJobDetails(params, function(err, data) {
            if(err) reject(err);
            else resolve(data);
        });
    });
}

// get s3 object
//
// return: promise
function getS3Object(params, dest) {
    return new Promise(function(resolve,reject) {
        console.log("Getting S3 Object '" + params.Bucket+"/"+params.Key + "' to '"+dest+"'");
        var file = fs.createWriteStream(dest);
        s3.getObject(params)
            .createReadStream()
            .on('error', reject)
            .pipe(file)
            .on('error', reject)
            .on('close', resolve);
    });
}

// put s3 object
//
// return: promise
function putS3Object(params, path) {
    return new Promise(function(resolve,reject) {
        console.log("Putting S3 Object '" + params.Bucket+"/"+params.Key + "' from '"+path+"'");
        params.Body = fs.createReadStream(path);
        s3.putObject(params, function(err, data) {
            if(err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

function uploadOutputArtifact(jobDetails, artifactName, path) {
    console.log("Uploading output artifact '" + artifactName + "' from '"+path+"'");

    // Get the output artifact
    var artifact = null;
    jobDetails.data.outputArtifacts.forEach(function (a) {
        if (a.name == artifactName) {
            artifact = a;
        }
    });

    if (artifact != null && artifact.location.type == 'S3') {
        var params = {
            Bucket: artifact.location.s3Location.bucketName,
            Key: artifact.location.s3Location.objectKey
        };
        return putS3Object(params, path);
    } else {
        return Promise.reject("Unknown Source Type:" + JSON.stringify(sourceOutput));
    }
}


// get input artifact
//
// return: promise
function downloadInputArtifact(jobDetails, artifactName, dest) {
    console.log("Downloading input artifact '" + artifactName + "' to '"+dest+"'");

    // Get the input artifact
    var artifact = null;
    jobDetails.data.inputArtifacts.forEach(function (a) {
        if (a.name == artifactName) {
            artifact = a;
        }
    });

    if (artifact != null && artifact.location.type == 'S3') {
        var params = {
            Bucket: artifact.location.s3Location.bucketName,
            Key: artifact.location.s3Location.objectKey
        };
        return getS3Object(params, dest);
    } else {
        return Promise.reject("Unknown Source Type:" + JSON.stringify(sourceOutput));
    }
}

function packTarball(sourceDirectory, destPath) {
    return new Promise(function (resolve, reject) {
        console.log("Creating tarball '"+destPath+"' from '"+sourceDirectory+"'");


        var packer = tar.Pack({ noProprietary: true, fromBase: true })
            .on('error', reject);

        var gzip = zlib.createGzip()
            .on('error', reject)

        var destFile = fs.createWriteStream(destPath)
            .on('error', reject)
            .on('close', resolve);

        fstream.Reader({ path: sourceDirectory, type: "Directory" })
            .on('error', reject)
            .pipe(packer)
            .pipe(gzip)
            .pipe(destFile);
    });
}

function extractTarball(sourcePath,destDirectory) {
    return new Promise(function (resolve, reject) {
        console.log("Extracting tarball '" + sourcePath+ "' to '" + destDirectory + "'");

        var sourceFile = fs.createReadStream(sourcePath)
            .on('error', reject);

        var gunzip = zlib.createGunzip()
            .on('error', reject)

        var extractor = tar.Extract({path: destDirectory})
            .on('error', reject)
            .on('end', resolve);

        sourceFile
            .pipe(gunzip)
            .pipe(extractor);
    });
}

function rmdir(dir) {
    if(!dir || dir == '/') {
        throw new Error('Invalid directory '+dir);
    }

    console.log("Cleaning directory '"+dir+"'");
    return exec('rm -rf '+dir);
}

// extract zip to directory
//
// return: promise
function extractZip(sourceZip,destDirectory) {
    return new Promise(function (resolve, reject) {
        console.log("Extracting zip: '"+sourceZip+"' to '"+destDirectory+"'");

        yauzl.open(sourceZip, {lazyEntries: true}, function(err, zipfile) {
            if (err) throw err;
            zipfile.readEntry();
            zipfile.on("error", reject);
            zipfile.on("end", resolve);
            zipfile.on("entry", function(entry) {
                if (/\/$/.test(entry.fileName)) {
                    // directory file names end with '/'
                    mkdirp(destDirectory+'/'+entry.fileName, function(err) {
                        if (err) throw err;
                        zipfile.readEntry();
                    });
                } else {
                    // file entry
                    zipfile.openReadStream(entry, function(err, readStream) {
                        if (err) throw err;
                        // ensure parent directory exists
                        mkdirp(destDirectory+'/'+path.dirname(entry.fileName), function(err) {
                            if (err) throw err;
                            readStream.pipe(fs.createWriteStream(destDirectory+'/'+entry.fileName));
                            readStream.on("end", function() {
                                zipfile.readEntry();
                            });
                        });
                    });
                }
            });
        });
    });
}

// install NPM
//
// return: promise
function installNpm(destDirectory) {
    console.log("Installing npm into '" + destDirectory + "'");
    return exec('cp -r '+__dirname+'/node_modules ' + destDirectory, {cwd: destDirectory});
}

// run npm install
//
// return: promise
function runNpm(packageDirectory, subcommand) {
    console.log("Running 'npm "+subcommand+"' in '"+packageDirectory+"'");
    return exec('node '+packageDirectory+'/node_modules/npm/bin/npm-cli.js '+subcommand, {cwd: packageDirectory});
}

// run gulp
//
// return: promise
function runGulp(packageDirectory, task, pipelineName) {

    console.log("Running gulp task '" + task + "' in '"+packageDirectory+"'");
    // clone the env, append npm to path
    var envCopy = {};
    for (var e in process.env) envCopy[e] = process.env[e];
    envCopy['PATH'] += (':'+packageDirectory+'/node_modules/.bin/');
    envCopy['PIPELINE_NAME'] = pipelineName;
    console.log("PATH: "+envCopy['PATH']);
    return exec('node '+packageDirectory+'/node_modules/gulp/bin/gulp.js --no-color '+task,{cwd: packageDirectory, env: envCopy});
}


// run shell script
//
function exec(command,options) {
    return new Promise(function (resolve, reject) {
        var child = childProcess.exec(command,options);

        var lastMessage = ""
        child.stdout.on('data', function(data) {
            lastMessage = data.toString('utf-8');
            process.stdout.write(data);
        });
        child.stderr.on('data', function(data) {
            lastMessage = data.toString('utf-8');
            process.stderr.write(data);
        });
        child.on('close', function (code) {
            if(!code) {
                resolve(true);
            } else {
                reject("Error("+code+") - "+lastMessage);
            }
        });
    });
}

