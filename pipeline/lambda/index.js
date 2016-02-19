'use strict'

var fs   = require('fs');
var AWS  = require('aws-sdk');
var AdmZip = require('adm-zip');
var spawn = require('child_process').spawn;

var codepipeline = new AWS.CodePipeline();
var s3 = new AWS.S3({maxRetries: 10, signatureVersion: "v4"});

function exec(command,args,cwd,callback) {
    var child = spawn(command, args, {cwd: cwd});

    var lastMessage = ""
    child.stdout.on('data', function(data) {
        lastMessage += data.toString('utf-8');
        process.stdout.write(data);
    });
    child.stderr.on('data', function(data) {
        lastMessage += data.toString('utf-8');
        process.stderr.write(data);
    });
    child.on('close', function (code) {
        if(!code) {
            callback();
        } else {
            callback("child process exited with code="+code+" message="+lastMessage);
        }
    });
}

// Notify AWS CodePipeline of a successful job
function putJobSuccess(message, event, context) {
    // Retrieve the Job ID from the Lambda action
    var jobId = event["CodePipeline.job"].id;

    var params = {
        jobId: jobId
    };
    codepipeline.putJobSuccessResult(params, function(err, data) {
        if(err) {
            context.fail(err);
        } else {
            context.succeed(message);
        }
    });
};

// Notify AWS CodePipeline of a failed job
function putJobFailure (message, event, context) {
    // Retrieve the Job ID from the Lambda action
    var jobId = event["CodePipeline.job"].id;

    var params = {
        jobId: jobId,
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
};

function runAction(jobId, callback) {
    var sourceZip = '/tmp/source.zip';
    var sourceExtract = '/tmp/source';

    var params = { jobId: jobId };
    codepipeline.getJobDetails(params, function(err, data) {
        if(err) {
            callback(err);
        } else {
            var jobDetails = data.jobDetails

            // Retrieve the value of UserParameters from the Lambda action configuration in AWS CodePipeline
            var task = jobDetails.data.actionConfiguration.configuration.UserParameters;

            // Get the intput artifact
            var sourceOutput = null;
            jobDetails.data.inputArtifacts.forEach(function(a) {
                if(a.name == "SourceOutput") {
                    sourceOutput = a;
                }
            });


            if(sourceOutput != null && sourceOutput.location.type == 'S3') {
                var params = {
                    Bucket: sourceOutput.location.s3Location.bucketName,
                    Key: sourceOutput.location.s3Location.objectKey
                };

                var file = fs.createWriteStream(sourceZip);
                s3.getObject(params)
                    .createReadStream()
                        .on('error', callback)
                    .pipe(file)
                        .on('error', callback)
                        .on('close', function () {
                            console.log("Extracting zip");

                            var zip = new AdmZip(sourceZip);
                            zip.extractAllTo(sourceExtract,true);

                            console.log("Installing npm");
                            exec('cp', ['-r','/var/task/node_modules',sourceExtract], sourceExtract, function(err, data) {
                                if(err) {
                                    callback(err);
                                } else {
                                    console.log("Running npm install");
                                    exec('node', ['./node_modules/npm/bin/npm-cli.js','install'], sourceExtract, function(err, data) {
                                        if(err) {
                                            callback(err);
                                        } else {
                                            console.log("Running gulp task: " + task);
                                            exec('./node_modules/gulp/bin/gulp.js', ['--no-color', task], sourceExtract, callback);
                                        }
                                    });
                                }
                            });


                        });

            } else {
                callback("Unknown Source Type:"+JSON.stringify(sourceOutput));
            }
        }

    });
}

exports.handler = function( event, context ) {
    try {
        console.log(JSON.stringify(event));

        runAction(event["CodePipeline.job"].id, function(err,data) {
            if(err) {
                putJobFailure(err,event,context);
            } else {
                putJobSuccess(data,event,context);
            }
        })

    } catch (e) {
        putJobFailure(e, event, context);
    }

};

exports.runAction = function(jobId,callback) {
    AWS.config.region = 'us-west-2';
    return runAction(jobId,callback);
}


