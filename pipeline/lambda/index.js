var AWS  = require('aws-sdk');
var gulp = require('gulp');
var runSequence = require('run-sequence');
require('./gulpfile.js');


exports.handler = function( event, context ) {


    var codepipeline = new AWS.CodePipeline();

    // Retrieve the Job ID from the Lambda action
    var jobId = event["CodePipeline.job"].id;

    // Retrieve the value of UserParameters from the Lambda action configuration in AWS CodePipeline
    var task = event["CodePipeline.job"].data.actionConfiguration.configuration.UserParameters;


    // Notify AWS CodePipeline of a successful job
    var putJobSuccess = function(message) {
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
    var putJobFailure = function(message) {
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

    // run gulp
    if (gulp.tasks[task]) {
        console.log("Running gulp task: "+task);
        runSequence(task,function(err) {
            if(err) {
                putJobFailure(err);
            } else {
                putJobSuccess("Task passed.");
            }
        });
    } else {
        putJobFailure("Missing gulp task: "+task);
    }

};




