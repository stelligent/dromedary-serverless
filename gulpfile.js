var gulp        = require('gulp');
var gcallback   = require('gulp-callback');
var gutil       = require('gulp-util');
var zip         = require('gulp-zip');
var install     = require('gulp-install');
var del         = require('del');
var runSequence = require('run-sequence');
var jshint      = require('gulp-jshint');
var AWS         = require('aws-sdk');
var fs          = require('fs');
var mime        = require('mime');
var git         = require('git-rev')
var moment      = require('moment');


// configuration
var pipelineConfig = {
    stackName: (gutil.env.stackName || 'dromedary-serverless'),
    githubBranch: 'config-api-baseurl',
    region: (gutil.env.region || 'us-west-2')
};


// AWS services
AWS.config.region = pipelineConfig.region
var s3             = new AWS.S3();
var cloudFormation = new AWS.CloudFormation();
var lambda         = new AWS.Lambda();


gulp.task('clean', function(cb) {
    return del(['./dist'],cb);
});

gulp.task('launch', function(cb) {
    return runSequence(
        ['cfn:up'],
        ['cfn:wait'],
        ['app:build'],
        ['app:uploadLambda'],
        ['app:uploadSite'],
        ['app:uploadConfig'],
        cb
    )
});

gulp.task('teardown', function(cb) {
    return runSequence(
        ['emptySite'],
        ['cfn:down'],
        cb
    )
});


gulp.task('app:js', function() {
    return gulp.src(['app/lambda/index.js'])
        .pipe(gulp.dest('dist/app/'));
});

gulp.task('app:node-mods', function() {
    return gulp.src('./package.json')
        .pipe(gulp.dest('dist/app/'))
        .pipe(install({production: true}));
});

gulp.task('app:zip', ['app:js','app:node-mods'], function() {
    return gulp.src(['!dist/app/package.json','!**/aws-sdk{,/**}','dist/app/**/*'])
        .pipe(zip('app.zip'))
        .pipe(gulp.dest('dist'));
});

gulp.task('app:build', function(cb) {
    return runSequence(
        ['clean'],
        ['app:zip'],
        cb
    )
});


//CloudFormation tasks
gulp.task('cfn:templatesBucket', function(cb) {
    var cfnBucket = pipelineConfig.stackName+"-templates";
    s3.headBucket({ Bucket: cfnBucket }, function(err, data) {
        if (err) {
            if(err.statusCode == 404) {
                s3.createBucket({
                    Bucket: cfnBucket,
                    CreateBucketConfiguration: {
                        LocationConstraint: pipelineConfig.region
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

gulp.task('cfn:templates',['cfn:templatesBucket'], function(cb) {
    var cfnBucket = pipelineConfig.stackName+"-templates";
    var complete = 0;
    var dirs = ['app/cfn','pipeline/cfn'];
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
gulp.task('cfn:customResources', ['cfn:templatesBucket'], function(cb) {
    var lambdaModules = [
        'cfn-api-gateway-restapi',
        'cfn-api-gateway-resource',
        'cfn-api-gateway-method',
        'cfn-api-gateway-method-response',
        'cfn-api-gateway-integration',
        'cfn-api-gateway-integration-response',
        'cfn-api-gateway-deployment'

    ];
    var cfnBucket = pipelineConfig.stackName+"-templates";

    var complete = 0;
    lambdaModules.forEach(function (moduleName) {
        zipLambdaModule(moduleName, function(err,zipfile) {
            if(err) {
                cb(err);
            } else {
                if(++complete >= lambdaModules.length) {
                    uploadToS3('./dist/lambdas/',cfnBucket, cb);
                }
            }
        });
    });
});


gulp.task('cfn:up',['cfn:templates','cfn:customResources'],  function() {
    return getStack(pipelineConfig.stackName, function(err, stack) {
        var action, status = stack && stack.StackStatus;
        if (!status || status === 'DELETE_COMPLETE') {
            action = 'createStack';
        } else if (status.match(/(CREATE|UPDATE)_COMPLETE/)) {
            action = 'updateStack';
        } else {
            return console.error('Stack "' + pipelineConfig.stackName + '" is currently in ' + status + ' status and can not be deployed.');
        }


        var s3Endpoint = (pipelineConfig.region=='us-east-1'?'https://s3.amazonaws.com':'https://s3-'+pipelineConfig.region+'.amazonaws.com');
        var cfnBucket = pipelineConfig.stackName+"-templates";
        var s3BucketURL = s3Endpoint+'/'+cfnBucket;

        var params = {
            StackName: pipelineConfig.stackName,
            Capabilities: ['CAPABILITY_IAM'],
            Parameters: [
                {
                    ParameterKey: "DDBTableName",
                    ParameterValue: pipelineConfig.stackName+'-ddb'
                },
                {
                    ParameterKey: "TemplateBucketName",
                    ParameterValue: cfnBucket
                },
                {
                    ParameterKey: "SiteBucketName",
                    ParameterValue: pipelineConfig.stackName+'-site'
                },
            ],
            TemplateURL: s3BucketURL+"/dromedary-master.json"
        };

        cloudFormation[action](params, function(err) {
            if (err) {
                throw err;
            }
            var a = action === 'createStack' ? 'creation' : 'update';
            console.log('Stack ' + a + ' in progress. Run gulp cfn:status to see current status.');
        });
    });
});

gulp.task('cfn:down',['emptySite'], function() {
    return getStack(pipelineConfig.stackName, function(err) {
        if (err) { throw err; }

        cloudFormation.deleteStack({StackName: pipelineConfig.stackName}, function(err) {
            if (err) {
                throw err;
            }
            console.log('Stack deletion in progress.');
        });
    });
});

gulp.task('cfn:wait', function(cb) {
    var stackName = pipelineConfig.stackName;
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

gulp.task('cfn:status', function() {
    var stackName = pipelineConfig.stackName;
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
        console.log('Use gulp cfn:log to view full event log');
        console.log('Use gulp cfn:resources to view list of resources in the stack');
    });
});

gulp.task('cfn:log', function() {
    var stackName = pipelineConfig.stackName;
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


gulp.task('cfn:resources', function() {
    var stackName = pipelineConfig.stackName;
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
gulp.task('app:uploadLambda', function(callback) {
    var aliasName = 'prod';
    getStack(pipelineConfig.stackName,function(err, stack) {
        if(err) {
            callback(err);
        } else if(!stack) {
            callback();
        } else {
            var appFunctionArn = stack.Outputs.filter(function (o) { return o.OutputKey == 'AppLambdaArn'})[0].OutputValue;
            var params = {
                FunctionName: appFunctionArn,
                Publish: true,
                ZipFile: fs.readFileSync('./dist/app.zip')
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

gulp.task('app:uploadSite', function(cb) {
    uploadToS3('node_modules/dromedary/public', pipelineConfig.stackName+ '-site', cb);
});
gulp.task('app:uploadConfig', function(cb) {
    getStack(pipelineConfig.stackName,function(err, stack) {
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
                    Bucket: pipelineConfig.stackName + '-site',
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

gulp.task('emptySite', function(cb) {
    emptyBucket(pipelineConfig.stackName+ '-site', cb);
});

gulp.task('pipeline:js', function() {
    return gulp.src(['pipeline/lambda/index.js','gulpfile.js'])
        .pipe(gulp.dest('dist/pipeline-lambda/'));
});

gulp.task('pipeline:node-mods', function() {
    return gulp.src('./package.json')
        .pipe(gulp.dest('dist/pipeline-lambda/'))
        .pipe(install({production: false}));
});

gulp.task('pipeline:zip', ['pipeline:js','pipeline:node-mods'], function() {
    return gulp.src(['!dist/pipeline-lambda/package.json','!**/aws-sdk{,/**}','dist/pipeline-lambda/**/*'])
        .pipe(zip('pipeline-lambda.zip'))
        .pipe(gulp.dest('dist'));
});

gulp.task('pipeline:uploadS3', ['pipeline:zip','cfn:templatesBucket'], function(cb) {
    var path = 'dist/pipeline-lambda.zip';
    var params = {
        Bucket: pipelineConfig.stackName+'-templates',
        Key: 'pipeline-lambda.zip',
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

gulp.task('pipeline:up',['cfn:templates','cfn:customResources','pipeline:uploadS3'],  function() {
    var stackName = pipelineConfig.stackName+'-pipeline';
    return getStack(stackName, function(err, stack) {
        var action, status = stack && stack.StackStatus;
        if (!status || status === 'DELETE_COMPLETE') {
            action = 'createStack';
        } else if (status.match(/(CREATE|UPDATE)_COMPLETE/)) {
            action = 'updateStack';
        } else {
            return console.error('Stack "' + stackName + '" is currently in ' + status + ' status and can not be deployed.');
        }


        var s3Endpoint = (pipelineConfig.region=='us-east-1'?'https://s3.amazonaws.com':'https://s3-'+pipelineConfig.region+'.amazonaws.com');
        var cfnBucket = pipelineConfig.stackName+"-templates";
        var s3BucketURL = s3Endpoint+'/'+cfnBucket;

        if(!gutil.env.token) {
            console.error("You must provide your GitHub token with `--token=XXXX`");
            process.exit(1);
        }

        var params = {
            StackName: stackName,
            Capabilities: ['CAPABILITY_IAM'],
            Parameters: [
                {
                    ParameterKey: "GitHubUser",
                    ParameterValue: "stelligent"
                },
                {
                    ParameterKey: "GitHubToken",
                    ParameterValue: gutil.env.token,
                },
                {
                    ParameterKey: "GitHubRepo",
                    ParameterValue: "dromedary"
                },
                {
                    ParameterKey: "GitHubBranch",
                    ParameterValue: pipelineConfig.githubBranch
                },
                {
                    ParameterKey: "TemplateBucketName",
                    ParameterValue: cfnBucket
                }
            ],
            TemplateURL: s3BucketURL+"/pipeline-master.json"
        };

        cloudFormation[action](params, function(err) {
            if (err) {
                throw err;
            }
            var a = action === 'createStack' ? 'creation' : 'update';
            console.log('Stack ' + a + ' in progress.');
        });
    });
});

gulp.task('pipeline:emptyArtifacts', function(callback) {
    getStack(pipelineConfig.stackName+'-pipeline',function(err, stack) {
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

gulp.task('pipeline:down', ['pipeline:emptyArtifacts'], function() {
    var stackName = pipelineConfig.stackName+'-pipeline';
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

gulp.task('pipeline:wait', function(cb) {
    var stackName = pipelineConfig.stackName+'-pipeline';
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

gulp.task('pipeline:status', function() {
    var stackName = pipelineConfig.stackName+"-pipeline";
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

gulp.task('pipeline:log', function() {
    var stackName = pipelineConfig.stackName+'-pipeline';
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


function zipLambdaModule(moduleName, cb) {
    var dist = './dist/lambdas';
    return gulp.src(['node_modules/'+moduleName+'/**/*','!node_modules/'+moduleName+'/package.json','!**/aws-sdk{,/**}'])
        .pipe(zip(moduleName+'.zip'))
        .pipe(gulp.dest(dist))
        .pipe(gcallback(function() {
            cb(null,dist+'/'+moduleName+'.zip');
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

