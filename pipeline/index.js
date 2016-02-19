'use strict'

var zip         = require('gulp-zip');
var del         = require('del');
var AWS         = require('aws-sdk');
var fs          = require('fs');
var mime        = require('mime');
var install     = require('gulp-install');


module.exports = function ( gulp, opts ) {
    // AWS services
    AWS.config.region = opts.region
    var s3             = new AWS.S3();
    var cloudFormation = new AWS.CloudFormation();
    var lambda         = new AWS.Lambda();

    var stackName = opts.stackName+'-pipeline';
    var cfnBucket = opts.stackName+"-templates";
    var taskPrefix = opts.taskPrefix || 'pipeline';
    var npmVersion = opts.npmVersion || '2';

    gulp.task(taskPrefix+':lambda:js', function() {
        return gulp.src(['lambda/index.js'])
            .pipe(gulp.dest('dist/lambda/'));
    });

    gulp.task(taskPrefix+':lambda:install', function() {
        return gulp.src('lambda/package.json')
            .pipe(gulp.dest('dist/lambda/'))
            .pipe(install({production: true}));
    });

    gulp.task(taskPrefix+':lambda:npm', function() {
        return gulp.src('lambda/npm'+npmVersion+'/**')
            .pipe(gulp.dest('dist/lambda/node_modules/npm/'));
    });

    gulp.task(taskPrefix+':lambda:zip', [taskPrefix+':lambda:js',taskPrefix+':lambda:install'], function() {
        return gulp.src(['!dist/lambda/package.json','!**/aws-sdk{,/**}','dist/lambda/**/*'])
            .pipe(zip('codepipeline-gulp.zip'))
            .pipe(gulp.dest('dist'));
    });

    gulp.task(taskPrefix+':lambda:upload', [taskPrefix+':lambda:gulpUpload', taskPrefix+':lambda:npmUpload']);

    gulp.task(taskPrefix+':lambda:gulpUpload', [taskPrefix+':lambda:zip'], function(callback) {
        getStack(stackName,function(err, stack) {
            if(err) {
                callback(err);
            } else if(!stack) {
                callback();
            } else {
                var pipelineFunctionArn = stack.Outputs.filter(function (o) { return o.OutputKey == 'CodePipelineGulpLambdaArn'})[0].OutputValue;
                var params = {
                    FunctionName: pipelineFunctionArn,
                    Publish: true,
                    ZipFile: fs.readFileSync('./dist/codepipeline-gulp.zip')
                };
                console.log("About to update function..."+pipelineFunctionArn);
                lambda.updateFunctionCode(params, function(err, data) {
                    if (err) {
                        callback(err);
                    } else {
                        console.log("Updated lambda to version: "+data.Version);
                        callback();
                    }
                });

            }
        })
    });
    gulp.task(taskPrefix+':lambda:npmUpload', [taskPrefix+':lambda:zip'], function(callback) {
        getStack(stackName,function(err, stack) {
            if(err) {
                callback(err);
            } else if(!stack) {
                callback();
            } else {
                var pipelineFunctionArn = stack.Outputs.filter(function (o) { return o.OutputKey == 'CodePipelineNpmLambdaArn'})[0].OutputValue;
                var params = {
                    FunctionName: pipelineFunctionArn,
                    Publish: true,
                    ZipFile: fs.readFileSync('./dist/codepipeline-gulp.zip')
                };
                console.log("About to update function..."+pipelineFunctionArn);
                lambda.updateFunctionCode(params, function(err, data) {
                    if (err) {
                        callback(err);
                    } else {
                        console.log("Updated lambda to version: "+data.Version);
                        callback();
                    }
                });

            }
        })
    });

    // Tasks to provision the pipeline
    gulp.task(taskPrefix+':templatesBucket', function(cb) {
        s3.headBucket({ Bucket: cfnBucket }, function(err, data) {
            if (err) {
                if(err.statusCode == 404) {
                    s3.createBucket({
                        Bucket: cfnBucket,
                        CreateBucketConfiguration: {
                            LocationConstraint: opts.region
                        }
                    }, function(err, data) {
                        if (err) {
                            cb(err);
                        } else {
                            console.log('Created bucket: '+cfnBucket);
                            cb();
                        }
                    });
                } else {
                    cb(err);
                }
            } else {
                console.log('Bucket already exists:'+ cfnBucket);
                cb();
            }
        });
    });

    gulp.task(taskPrefix+':templates',[taskPrefix+':templatesBucket'], function(cb) {
        var complete = 0;
        var dirs = ['cfn'];
        dirs.forEach(function(dir) {
            uploadToS3(dir,cfnBucket,function(err) {
                if(err) {
                    cb(err);
                } else {
                    if (++complete >= dirs.length) {
                        cb();
                    }
                }
            });
        });
    });


    gulp.task(taskPrefix+':lambda:uploadS3', [taskPrefix+':lambda:zip',taskPrefix+':templatesBucket'], function(cb) {
        var path = 'dist/codepipeline-gulp.zip';
        var params = {
            Bucket: cfnBucket,
            Key: 'codepipeline-gulp.zip',
            ACL: 'public-read',
            ContentType: mime.lookup(path),
            Body: fs.readFileSync(path)
        }

        s3.putObject(params, function(err, data) {
            if (err) {
                cb(err);
            } else {
                cb();
            }
        });
    });

    gulp.task(taskPrefix+':up',[taskPrefix+':templates',taskPrefix+':lambda:uploadS3'],  function() {
        return getStack(stackName, function(err, stack) {
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
                        ParameterKey: "GulpStaticAnalysisTask",
                        ParameterValue: opts.gulpStaticAnalysisTask
                    },
                    {
                        ParameterKey: "GulpUnitTestTask",
                        ParameterValue: opts.gulpUnitTestTask
                    },
                    {
                        ParameterKey: "GulpLaunchTask",
                        ParameterValue: opts.gulpLaunchTask
                    },
                    {
                        ParameterKey: "GulpDeployAppTask",
                        ParameterValue: opts.gulpDeployAppTask
                    },
                    {
                        ParameterKey: "GulpDeploySiteTask",
                        ParameterValue: opts.gulpDeploySiteTask
                    },
                    {
                        ParameterKey: "GulpDeployConfigTask",
                        ParameterValue: opts.gulpDeployConfigTask
                    },
                    {
                        ParameterKey: "GulpFunctionalTestTask",
                        ParameterValue: opts.gulpFunctionalTestTask
                    },
                    {
                        ParameterKey: "GulpProductionDNSTask",
                        ParameterValue: opts.gulpProductionDNSTask
                    },
                    {
                        ParameterKey: "TemplateBucketName",
                        ParameterValue: cfnBucket
                    }
                ],
                TemplateURL: s3BucketURL+"/pipeline-master.json"
            };
            params.Parameters = params.Parameters.filter(function(p) { return p.ParameterValue; });

            cloudFormation[action](params, function(err) {
                if (err) {
                    throw err;
                }
                var a = action === 'createStack' ? 'creation' : 'update';
                console.log('Stack ' + a + ' in progress.');
            });
        });
    });

    gulp.task(taskPrefix+':emptyArtifacts', function(callback) {
        getStack(stackName,function(err, stack) {
            if (err) {
                callback(err);
            } else if (!stack) {
                callback();
            } else {
                var artifactBucket = stack.Outputs.filter(function (o) { return o.OutputKey == 'ArtifactBucket' })[0].OutputValue;
                emptyBucket(artifactBucket, callback);
            }
        });
    });

    gulp.task(taskPrefix+':down', [taskPrefix+':emptyArtifacts'], function() {
        return getStack(stackName, function(err) {
            if (err) { throw err; }

            cloudFormation.deleteStack({StackName: stackName}, function(err) {
                if (err) {
                    throw err;
                }
                console.log('Stack deletion in progress.');
            });
        });
    });

    gulp.task(taskPrefix+':wait', function(cb) {
        var checkFunction = function() {
            getStack(stackName, function(err,stack) {
                if (err) {
                    throw err;
                } else {
                    if(!stack || /_IN_PROGRESS$/.test(stack.StackStatus)) {
                        console.log("      StackStatus = "+(stack!=null?stack.StackStatus:'NOT_FOUND'));
                        setTimeout(checkFunction, 5000);
                    } else {
                        console.log("Final StackStatus = "+stack.StackStatus);
                        cb();
                    }
                }
            });
        };

        checkFunction();
    });

    gulp.task(taskPrefix+':status', function() {
        return getStack(stackName, function(err, stack) {
            if (err) {
                throw err;
            }
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
        return getStack(stackName, function(err, stack) {
            if (err) {
                throw err;
            }
            if (!stack) {
                return console.log('Stack does not exist: ' + stackName);
            }
            if (!stack.StackStatus.match(/(CREATE|UPDATE)_COMPLETE/)) {
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
            }
        });
    });

    function getStack(stackName, cb) {
        cloudFormation.describeStacks({StackName: stackName}, function(err, data) {
            if (err || data.Stacks == null) {
                cb(null,null);
                return;
            }
            for (var i=0; i<data.Stacks.length; i++) {
                if (data.Stacks[i].StackName === stackName) {
                    return cb(null, data.Stacks[i]);
                }
            }
            return cb();
        });
    }

    function emptyBucket(bucket,cb) {
        s3.listObjects({Bucket: bucket}, function(err, data) {
            if (err) {
                cb();
            } else {

                var objects = data.Contents.map(function (c) { return { Key: c.Key }});
                var params = {
                    Bucket: bucket,
                    Delete: {
                        Objects: objects
                    }
                };

                if(objects.length > 0) {
                    s3.deleteObjects(params, function(err) {
                        if (err) {
                            cb(err);
                        } else {
                            cb();
                        }
                    });
                } else {
                    cb();
                }
            }
        });
    }
    function uploadToS3(dir,bucket,cb) {
        var files = fs.readdirSync(dir);
        var respCount = 0;
        for (var i in files){
            var path = dir + '/' + files[i];
            if (!fs.statSync(path).isDirectory()) {
                console.log("Uploading: "+ path);
                var params = {
                    Bucket: bucket,
                    Key: files[i],
                    ACL: 'public-read',
                    ContentType: mime.lookup(path),
                    Body: fs.readFileSync(path)
                }

                s3.putObject(params, function(err, data) {
                    if (err) {
                        console.log(err, err.stack);
                    }

                    if(++respCount >= files.length) {
                        cb();
                    }
                });
            } else {
                respCount++;
            }
        }

        if(files.length==0) {
            cb();
        }
    }

};





