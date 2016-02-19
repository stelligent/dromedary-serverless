'use strict'

var gulp        = require('gulp');
var gutil       = require('gulp-util');


var pipelineConfig = {
    region: (gutil.env.region || 'us-west-2'),
    stackName: (gutil.env.stackName || 'dromedary-serverless'),
    githubToken: gutil.env.token,
    githubUser: 'stelligent',
    githubRepo: 'dromedary',
    githubBranch: 'serverless'
};

var gpipeline   = require('.');
gpipeline(gulp,pipelineConfig);


gulp.task('testNpmAction', ['pipeline:lambda:js','pipeline:lambda:install'], function(cb) {
    process.env.AWS_DEFAULT_REGION = 'us-west-2';
    var event = {
        "CodePipeline.job": {
            "id": "8288938e-5c9c-49da-80d9-b637069c8683",
            "accountId": "324320755747",
            "data": {
                "actionConfiguration": {
                    "configuration": {
                        "FunctionName": "dromedary-serverless-pipelin-CodePipelineNpmLambda-12730MJYCWL09",
                        "UserParameters": "install"
                    }
                },
                "inputArtifacts": [
                    {
                        "location": {
                            "s3Location": {
                                "bucketName": "dromedary-serverless-pipeline-artifactbucket-f7vk0bfu30n1",
                                "objectKey": "dromedary-serverless/SourceOutp/SWUkOWF.zip"
                            },
                            "type": "S3"
                        },
                        "name": "SourceOutput"
                    }
                ],
                "outputArtifacts": [
                    {
                        "location": {
                            "s3Location": {
                                "bucketName": "dromedary-serverless-pipeline-artifactbucket-f7vk0bfu30n1",
                                "objectKey": "dromedary-serverless/SourceInst/kJbj9QO"
                            },
                            "type": "S3"
                        },
                        "name": "SourceInstalledOutput"
                    }
                ]
            }

        }
    };
    var context = {
        fail: function(e) {
            cb(e);
        },
        succeed: function(m) {
            cb(null,m);
        }
    };
    var lambda = require('./lambda');
    lambda.npmHandler(event, context);
});

gulp.task('testGulpAction', ['pipeline:lambda:js','pipeline:lambda:install'], function(cb) {
    process.env.AWS_DEFAULT_REGION = 'us-west-2';
    var event = {
        "CodePipeline.job": {
            "id": "8288938e-5c9c-49da-80d9-b637069c8683",
            "accountId": "324320755747",
            "data": {
                "actionConfiguration": {
                    "configuration": {
                        "FunctionName": "dromedary-serverless-pipelin-CodePipelineNpmLambda-12730MJYCWL09",
                        "UserParameters": "test"
                    }
                },
                "inputArtifacts": [
                    {
                        "location": {
                            "s3Location": {
                                "bucketName": "dromedary-serverless-pipeline-artifactbucket-f7vk0bfu30n1",
                                "objectKey": "dromedary-serverless/SourceInst/kJbj9QO"
                            },
                            "type": "S3"
                        },
                        "name": "SourceInstalledOutput"
                    }
                ],
                "outputArtifacts": [
                ]
            }

        }
    };
    var context = {
        fail: function(e) {
            cb(e);
        },
        succeed: function(m) {
            cb(null,m);
        }
    };
    var lambda = require('./lambda');
    lambda.gulpHandler(event, context);
});

