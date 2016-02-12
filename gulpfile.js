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
    region: (gutil.env.region || 'us-west-2')
};


// AWS services
AWS.config.region = pipelineConfig.region
var s3             = new AWS.S3();
var cloudFormation = new AWS.CloudFormation();
var lambda         = new AWS.Lambda();


gulp.task('clean', function(cb) {
    return del(['./dist', './dist.zip'],cb);
});

gulp.task('launch', function(cb) {
    return runSequence(
        ['cfn:up'],
        ['cfn:wait'],
        ['build'],
        ['uploadLambda'],
        ['uploadSite'],
        ['uploadConfig'],
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


gulp.task('js', function() {
    return gulp.src(['index.js'])
        .pipe(gulp.dest('dist/'));
});

gulp.task('node-mods', function() {
    return gulp.src('./package.json')
        .pipe(gulp.dest('dist/'))
        .pipe(install({production: true}));
});

gulp.task('zip', ['js','node-mods'], function() {
    return gulp.src(['!dist/package.json','!**/aws-sdk{,/**}','dist/**/*'])
        .pipe(zip('dist.zip'))
        .pipe(gulp.dest('./'));
});

gulp.task('build', function(cb) {
    return runSequence(
        ['clean'],
        ['zip'],
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
    uploadToS3('pipeline/cfn',cfnBucket, cb);
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
gulp.task('uploadLambda', function(callback) {
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
                ZipFile: fs.readFileSync('./dist.zip')
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

gulp.task('uploadSite', function(cb) {
    uploadToS3('node_modules/dromedary/public', pipelineConfig.stackName+ '-site', cb);
});
gulp.task('uploadConfig', function(cb) {
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



function zipLambdaModule(moduleName, cb) {
    var dist = './dist/lambdas/';
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

