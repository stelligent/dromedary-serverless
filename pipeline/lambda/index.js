'use strict'

var fs   = require('fs');
var AWS  = require('aws-sdk');
var AdmZip = require('adm-zip');
var archiver = require('archiver');
var Promise = require('promise');
var childProcess = require('child_process');

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
    promise.then(function(message) {
                var params = {
                    jobId: event["CodePipeline.job"].id
                };
                codepipeline.putJobSuccessResult(params, function(err, data) {
                    if(err) {
                        context.fail(err);
                    } else {
                        context.succeed(message);
                    }
                });
        }).catch( function(message) {
            var params = {
                jobId: event["CodePipeline.job"].id,
                failureDetails: {
                    message: JSON.stringify(message),
                    type: 'JobFailed',
                    externalExecutionId: context.invokeid
                }
            };
            console.error(JSON.stringify(message));

            codepipeline.putJobFailureResult(params, function(err, data) {
                context.fail(message);
            });

        });

};

// run npm
//
// return: promise
function npmAction(jobDetails) {
    var artifactName = 'SourceOutput';
    var artifactZipPath = '/tmp/source.zip';
    var artifactExtractPath = '/tmp/source/';

    var outArtifactName = 'SourceInstalledOutput';
    var outArtifactZipPath = '/tmp/source_installed.zip';

    return downloadInputArtifact(jobDetails, artifactName, artifactZipPath)
        .then(function () {
            return extractZip(artifactZipPath, artifactExtractPath);
        }).then(function () {
            return installNpm(artifactExtractPath);
        }).then(function () {
            var subcommand = jobDetails.data.actionConfiguration.configuration.UserParameters;
            return runNpm(artifactExtractPath, subcommand);
        }).then(function () {
            return createZip(artifactExtractPath, outArtifactZipPath);
        }).then(function () {
            return uploadOutputArtifact(jobDetails, outArtifactName, outArtifactZipPath);
        });
}


// run gulp
//
// return: promise
function gulpAction(jobDetails) {
    var artifactName = 'SourceInstalledOutput';
    var artifactZipPath = '/tmp/source_installed.zip';
    var artifactExtractPath = '/tmp/source_installed/';

    return downloadInputArtifact(jobDetails, artifactName, artifactZipPath)
        .then(function () {
            return extractZip(artifactZipPath, artifactExtractPath);
        }).then(function () {
            return installNpm(artifactExtractPath);
        }).then(function () {
            var taskName = jobDetails.data.actionConfiguration.configuration.UserParameters;
            return runGulp(artifactExtractPath, taskName);
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
    console.log("Getting S3 Object '" + params.Bucket+"/"+params.Key + "' to '"+dest+"'");
    var file = fs.createWriteStream(dest);
    return new Promise(function(resolve,reject) {
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
    console.log("Putting S3 Object '" + params.Bucket+"/"+params.Key + "' from '"+path+"'");
    params.Body = fs.createReadStream(path);
    return new Promise(function(resolve,reject) {
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
    console.log("Uploading output artifact '" + artifactName + "' from '"+artifactExtractPath+"'");

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

function createZip(sourceDirectory, destZip) {
    console.log("Creating zip '"+destZip+"' from '"+sourceDirectory+"'");

    return new Promise(function (resolve, reject) {
        var archive = archiver.create('zip', {});
        var output = fs.createWriteStream(destZip);

        output.on('close', resolve);
        archive.on('error', reject);

        archive.pipe(output);

        archive.bulk([{
            expand: true,
            cwd: sourceDirectory,
            src: ['**']
        }]);

        archive.finalize();
    });

}

// extract zip to directory
//
// return: promise
function extractZip(sourceZip,destDirectory) {
    if(!destDirectory || destDirectory == '/') {
        throw new Error('Invalid destDirectory '+destDirectory);
    }

    console.log("Cleaning directory '"+destDirectory+"'");
    return exec('rm -rf '+destDirectory)
        .then(function() {
            console.log("Extracting zip: '"+sourceZip+"' to '"+destDirectory+"'");

            var zip = new AdmZip(sourceZip);
            zip.extractAllTo(destDirectory,true);

            return Promise.resolve(true);
        })
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
    return exec('node ./node_modules/npm/bin/npm-cli.js '+subcommand, {cwd: packageDirectory});
}

// run gulp
//
// return: promise
function runGulp(packageDirectory, task) {
    console.log("Running gulp task '" + task + "' in '"+packageDirectory+"'");
    return exec('node ./node_modules/gulp/bin/gulp.js --no-color '+task,{cwd: packageDirectory});
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

