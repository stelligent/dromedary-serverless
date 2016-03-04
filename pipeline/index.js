'use strict'

var AWS         = require('aws-sdk');
var fs          = require('fs');
var mime        = require('mime');
var chalk       = require('chalk');
var Promise     = require('promise');

var util        = require('./util.js');

exports.registerTasks = function ( gulp, opts ) {
    util.init(opts.region);
    var cloudFormation = new AWS.CloudFormation();

    var stackName = opts.stackName || 'serverless-pipeline';
    var cfnBucket = opts.cfnBucket || 'serverless-pipeline';
    var taskPrefix = opts.taskPrefix || 'pipeline';


    gulp.task(taskPrefix+':up',  function() {
        return util.getStack(stackName).then(function(stack) {
            var action, status = stack && stack.StackStatus;
            if (!status || status === 'DELETE_COMPLETE') {
                action = 'createStack';
            } else if (status.match(/(CREATE|UPDATE)_COMPLETE/)) {
                action = 'updateStack';
            } else {
                return console.error('Stack "' + stackName + '" is currently in ' + status + ' status and can not be deployed.');
            }


            var s3Endpoint = (opts.region=='us-east-1'?'https://s3.amazonaws.com':'https://s3-'+opts.region+'.amazonaws.com');
            var s3BucketURL = s3Endpoint+'/'+cfnBucket;

            var params = {
                StackName: stackName,
                Capabilities: ['CAPABILITY_IAM'],
                Parameters: [
                    {
                        ParameterKey: "GitHubUser",
                        ParameterValue: opts.githubUser
                    },
                    {
                        ParameterKey: "GitHubToken",
                        ParameterValue: opts.githubToken
                    },
                    {
                        ParameterKey: "GitHubRepo",
                        ParameterValue: opts.githubRepo
                    },
                    {
                        ParameterKey: "GitHubBranch",
                        ParameterValue: opts.githubBranch
                    },
                    {
                        ParameterKey: "GulpPackageTask",
                        ParameterValue: opts.gulpPackageTask
                    },
                    {
                        ParameterKey: "GulpTestTask",
                        ParameterValue: opts.gulpTestTask
                    },
                    {
                        ParameterKey: "HostedZoneId",
                        ParameterValue: opts.hostedZoneId
                    },
                    {
                        ParameterKey: "TestSiteFQDN",
                        ParameterValue: opts.testSiteFQDN
                    },
                    {
                        ParameterKey: "ProdSiteFQDN",
                        ParameterValue: opts.prodSiteFQDN
                    },
                    {
                        ParameterKey: "DistSitePath",
                        ParameterValue: opts.distSitePath
                    },
                    {
                        ParameterKey: "DistLambdaPath",
                        ParameterValue: opts.distLambdaPath
                    },
                    {
                        ParameterKey: "DistSwaggerPath",
                        ParameterValue: opts.distSwaggerPath
                    },
                    {
                        ParameterKey: "TemplateBucketName",
                        ParameterValue: cfnBucket
                    }
                ],
                TemplateURL: s3BucketURL+"/master.json"
            };
            params.Parameters = params.Parameters.filter(function(p) { return p.ParameterValue; });

            return new Promise(function(resolve,reject) {
                cloudFormation[action](params, function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        var a = action === 'createStack' ? 'creation' : 'update';
                        console.log('Stack ' + a + ' in progress.');
                        resolve();
                    }
                });

            });
        });
    });

    gulp.task(taskPrefix+':emptyArtifacts', function() {
        return util.getSubStackOutput(stackName,'PipelineStack','ArtifactBucket')
            .then(function(bucketName) {
                return util.emptyBucket(bucketName);
            }).catch(function(){
                return true;
            });
    });

    gulp.task(taskPrefix+':emptyTestSite', function() {
        return util.emptyBucket(opts.testSiteFQDN);
    });

    gulp.task(taskPrefix+':emptyProdSite', function() {
        return util.emptyBucket(opts.prodSiteFQDN);
    });

    gulp.task(taskPrefix+':down', [taskPrefix+':emptyArtifacts',taskPrefix+':emptyTestSite',taskPrefix+':emptyProdSite'], function(cb) {
        return util.getStack(stackName).then(function() {
            return new Promise(function(resolve,reject) {
                cloudFormation.deleteStack({StackName: stackName}, function(err) {
                    if(err)
                        reject(err);
                    else {
                        console.log('Stack deletion in progress.');
                        resolve();
                    }
                });
            });
        });
    });

    gulp.task(taskPrefix+':wait', function(cb) {
        var checkFunction = function() {
            util.getStack(stackName).then(function(stack) {
                    if(!stack || /_IN_PROGRESS$/.test(stack.StackStatus)) {
                        console.log("      StackStatus = "+(stack!=null?stack.StackStatus:'NOT_FOUND'));
                        setTimeout(checkFunction, 5000);
                    } else {
                        console.log("Final StackStatus = "+stack.StackStatus);
                        cb();
                    }
            });
        };

        checkFunction();
    });

    gulp.task(taskPrefix+':status', function() {
        return util.getStack(stackName)
            .then(function(stack) {
                if (!stack) {
                    return console.error('Stack does not exist: ' + stackName);
                }
                console.log('Status: '+stack.StackStatus);
                console.log('Outputs: ');
                stack.Outputs.forEach(function (output) {
                    console.log('  '+output.OutputKey+' = '+output.OutputValue);
                });
                console.log('');
                console.log('Use gulp pipeline:log to view full event log');

            });
    });

    gulp.task(taskPrefix+':log', function() {
        return util.getStack(stackName)
            .then(function(stack){
                if (!stack) {
                    return console.log('Stack does not exist: ' + stackName);
                }

                cloudFormation.describeStackEvents({StackName: stackName}, function(err, data) {
                    if (!data) {
                        console.log('No log info available for ' + stackName);
                        return;
                    }
                    var events = data.StackEvents;
                    events.sort(function(a, b) {
                        return new Date(a.Timestamp).getTime() - new Date(b.Timestamp).getTime();
                    });
                    events.forEach(function(event) {
                        event.Timestamp = new Date(event.Timestamp).toLocaleString().replace(',', '');
                        event.ResourceType = '[' + event.ResourceType + ']';
                        console.log(event.Timestamp+' '+event.ResourceStatus+' '+event.LogicalResourceId+event.ResourceType+' '+event.ResourceStatusReason);
                    });
                });

            });
    });
};

