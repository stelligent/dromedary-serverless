'use strict'

var AWS  = require('aws-sdk');
var gulp = require('gulp');
var unzip = require('unzip');
var runSequence = require('run-sequence');
require('./gulpfile.js');

var codepipeline = new AWS.CodePipeline();
var s3 = new AWS.S3({maxRetries: 10, signatureVersion: "v4"});


function getArtifact(event, artifactName) {
    var artifact;
    event["CodePipeline.job"].data.inputArtifacts.forEach(function(a) {
        if(a.name == artifactName) {
            artifact = a;
        }
    });
    return artifact;
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

function runTask(event,context) {
    // Retrieve the value of UserParameters from the Lambda action configuration in AWS CodePipeline
    var task = event["CodePipeline.job"].data.actionConfiguration.configuration.UserParameters;

    // run gulp
    console.log("Running gulp task: "+task);
    runSequence(task,function(err) {
        if(err) {
            putJobFailure(err, event, context);
        } else {
            putJobSuccess("Task passed.", event, context);
        }
    });
}

exports.handler = function( event, context ) {
    try {
        console.log(JSON.stringify(event["CodePipeline.job"]));

        // Get the intput artifact
        var sourceOutput = getArtifact(event, 'SourceOutput');

        if(sourceOutput.location.type == 'S3') {
            var params = {
                Bucket: sourceOutput.location.s3Location.bucketName,
                Key: sourceOutput.location.s3Location.objectKey
            };

            /*
            s3.getObject(params).createReadStream()
                .pipe(unzip.Extract({ path: '/tmp/source/' }))
                .on('end', function() {
                        console.log("got end event.")
                        runTask(event,context);
                })
                .on('httpDone', function() {
                    console.log("got httpDone event.")
                    runTask(event,context);
                });
                */
            /*
                file.end();

                fs.createReadStream('path/to/archive.zip').pipe(unzip.Extract({ path: 'output/path' }));

                runTask(event,context);
                */
            /*

                */
            var file = require('fs').createWriteStream('/tmp/source.zip');
            s3.getObject(params)
                .on('httpData', function(chunk) { file.write(chunk); })
                .on('httpDone', function() {
                    file.end();

                    console.log("Done writing zip file");

                    fs.createReadStream('/tmp/source.zip')
                      .pipe(unzip.Extract({ path: '/tmp/source/' }))
                      .on('error', function(e) {
                          console.log("got error event.")
                          putJobFailure(e, event, context);
                      })
                      .on('finish', function() {
                        console.log("got finish event.")
                        runTask(event,context);
                      })
                      .on('end', function() {
                        console.log("got end event.")
                        runTask(event,context);
                      })

                })
                .send();
        }

    } catch (e) {
        putJobFailure(e, event, context);
    }

};




