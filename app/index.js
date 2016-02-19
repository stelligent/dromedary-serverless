var gulp        = require('gulp');
var gcallback   = require('gulp-callback');
var zip         = require('gulp-zip');
var unzip       = require('gulp-unzip');
var install     = require('gulp-install');
var del         = require('del');
var runSequence = require('run-sequence');
var AWS         = require('aws-sdk');
var fs          = require('fs');
var mime        = require('mime');
var git         = require('git-rev')
var moment      = require('moment');


exports.registerTasks = function ( gulp, opts ) {
    // AWS services
    AWS.config.region = opts.region
    var s3 = new AWS.S3();
    var cloudFormation = new AWS.CloudFormation();
    var lambda = new AWS.Lambda();

    var stackName = opts.stackName || 'serverless-app';
    var siteDirectory = opts.siteDirectory;
    var appSource = opts.appSource;
    var cfnBucket = opts.cfnBucket || stackName + "-templates";
    var siteBucket = opts.siteBucket || stackName + "-site";
    var taskPrefix = opts.taskPrefix || 'app';
    var dist = (opts.dist || '/tmp/dist') + '/serverless-app';

    gulp.task(taskPrefix+':launch', function(cb) {
        return runSequence(
            [taskPrefix+':up'],
            [taskPrefix+':wait'],
            [taskPrefix+':lambda:upload'],
            [taskPrefix+':uploadSite'],
            [taskPrefix+':uploadConfig'],
            cb
        )
    });

    gulp.task(taskPrefix+':teardown', function(cb) {
        return runSequence(
            [taskPrefix+':emptySite'],
            [taskPrefix+':down'],
            cb
        )
    });

    gulp.task(taskPrefix+':lambda:clean', function(cb) {
        return del([dist],{force: true}, cb);
    });

    gulp.task(taskPrefix+':lambda:js', function() {
        return gulp.src(appSource)
            .pipe(gulp.dest(dist+'/app/'));
    });

    gulp.task(taskPrefix+':lambda:installProd', function() {
        return gulp.src(['./package.json','./app{,/lambda/*}'])
            .pipe(gulp.dest(dist+'/app/'))
            .pipe(install({production: true}));
    });

    gulp.task(taskPrefix+':lambda:zip', [taskPrefix+':lambda:js',taskPrefix+':lambda:installProd'], function() {
        return gulp.src(['!'+dist+'/app/package.json',
                         '!'+dist+'/**/aws-sdk{,/**}',
                         '!'+dist+'/app/app',
                         '!'+dist+'/app/pipeline',
                         dist+'/app/**/*'])
            .pipe(zip('app.zip'))
            .pipe(gulp.dest(dist));
    });

    gulp.task(taskPrefix+':lambda:build', function(cb) {
        return runSequence(
            [taskPrefix+':lambda:clean'],
            [taskPrefix+':lambda:zip'],
            cb
        )
    });
    gulp.task(taskPrefix+':emptySite', function(cb) {
        emptyBucket(siteBucket, cb);
    });

    gulp.task(taskPrefix+':uploadSite', function(cb) {
        uploadToS3(siteDirectory, siteBucket, cb);
    });
    gulp.task(taskPrefix+':uploadConfig', function(cb) {
        getStack(stackName,function(err, stack) {
            if (err) {
                cb(err);
            } else if (!stack) {
                cb();
            } else {
                git.long(function (sha) {
                    if(sha == "") {
                        // default to a timestamp
                        sha = moment().format('YYYYMMDD-HHmmss');
                    }

                    var apiUrl = stack.Outputs.filter(function (o) { return o.OutputKey == 'ApiURL' })[0].OutputValue + '/';
                    var config = {
                        apiBaseurl: apiUrl,
                        version: sha
                    }

                    var params = {
                        Bucket: siteBucket,
                        Key: 'config.json',
                        ACL: 'public-read',
                        ContentType: 'application/javascript',
                        Body: JSON.stringify(config)
                    }

                    s3.putObject(params, function (err, data) {
                        if (err) {
                            cb(err);
                        } else {
                            cb();
                        }
                    });

                })
            }
        });
    });

    //CloudFormation tasks
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
        var dirs = ['app/cfn'];
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
    gulp.task(taskPrefix+':customResources', [taskPrefix+':templatesBucket'], function(cb) {
        var lambdaModules = [
            'cfn-api-gateway-restapi',
            'cfn-api-gateway-resource',
            'cfn-api-gateway-method',
            'cfn-api-gateway-method-response',
            'cfn-api-gateway-integration',
            'cfn-api-gateway-integration-response',
            'cfn-api-gateway-deployment'

        ];

        var complete = 0;
        lambdaModules.forEach(function (moduleName) {
            zipLambdaModule(moduleName, function(err,zipfile) {
                if(err) {
                    cb(err);
                } else {
                    if(++complete >= lambdaModules.length) {
                        uploadToS3(dist+'/lambdas/',cfnBucket, cb);
                    }
                }
            });
        });
    });


    gulp.task(taskPrefix+':up',[taskPrefix+':templates',taskPrefix+':customResources'],  function() {
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
                        ParameterKey: "DDBTableName",
                        ParameterValue: stackName+'-ddb'
                    },
                    {
                        ParameterKey: "TemplateBucketName",
                        ParameterValue: cfnBucket
                    },
                    {
                        ParameterKey: "SiteBucketName",
                        ParameterValue: siteBucket
                    },
                ],
                TemplateURL: s3BucketURL+"/main.json"
            };

            cloudFormation[action](params, function(err) {
                if (err) {
                    throw err;
                }
                var a = action === 'createStack' ? 'creation' : 'update';
                console.log('Stack ' + a + ' in progress. Run gulp '+taskPrefix+':status to see current status.');
            });
        });
    });

    gulp.task(taskPrefix+':down',[taskPrefix+':emptySite'], function() {
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
            console.log('Use gulp '+taskPrefix+':log to view full event log');
            console.log('Use gulp '+taskPrefix+':resources to view list of resources in the stack');
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


    gulp.task(taskPrefix+':resources', function() {
        return getStack(stackName, function(err, stack) {
            if (err) {
                throw err;
            }
            if (!stack) {
                return console.error('Stack does not exist: ' + stackName);
            }
            cloudFormation.listStackResources({StackName: stackName}, function(err, data) {
                if (!data) {
                    console.log('No resources available for ' + stackName);
                    return;
                }
                var resources = data.StackResourceSummaries;
                resources.forEach(function(resource) {
                    if (!resource.LogicalResourceId) {
                        resource.LogicalResourceId = '(unknown)';
                    }
                    console.log('Type='+resource.ResourceType+' LogicalId='+resource.LogicalResourceId+' PhysicalId='+resource.PhysicalResourceId+' Status='+resource.ResourceStatus)
                });
            });
        });
    });

    //Application upload tasks
    gulp.task(taskPrefix+':lambda:upload', [taskPrefix+':lambda:build'], function(callback) {
        var aliasName = 'prod';
        getStack(stackName,function(err, stack) {
            if(err) {
                callback(err);
            } else if(!stack) {
                callback();
            } else {
                var appFunctionArn = stack.Outputs.filter(function (o) { return o.OutputKey == 'AppLambdaArn'})[0].OutputValue;
                var params = {
                    FunctionName: appFunctionArn,
                    Publish: true,
                    ZipFile: fs.readFileSync(dist+'/app.zip')
                };
                lambda.updateFunctionCode(params, function(err, data) {
                    if (err) {
                        callback(err);
                    } else {
                        console.log("Updated lambda to version: "+data.Version);
                        var aliasParams = {
                            FunctionName: appFunctionArn,
                            FunctionVersion: data.Version,
                            Name: aliasName
                        };
                        lambda.deleteAlias({'FunctionName': appFunctionArn, Name: aliasName}, function() {
                            lambda.createAlias(aliasParams, function (err, data) {
                                if (err) {
                                    callback(err);
                                } else {
                                    console.log("Tagged lambda version: " + aliasParams.FunctionVersion+ " as " + aliasName);
                                    callback();
                                }
                            });
                        });
                    }
                });

            }
        })
    });

    function zipLambdaModule(moduleName, cb) {
        return gulp.src(['node_modules/'+moduleName+'/**/*','!node_modules/'+moduleName+'/package.json','!**/aws-sdk{,/**}'])
            .pipe(zip(moduleName+'.zip'))
            .pipe(gulp.dest(dist+'/lambdas'))
            .pipe(gcallback(function() {
                cb(null,dist+'/lambdas/'+moduleName+'.zip');
            }));
    }
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


