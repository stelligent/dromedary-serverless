var gulp        = require('gulp');
var zip        = require('gulp-zip');
var install     = require('gulp-install');
var del         = require('del');
var runSequence = require('run-sequence');
var jshint      = require('gulp-jshint');
var awsLambda = require("node-aws-lambda");
var AWS         = require('aws-sdk');
var fs          = require('fs');
var mime        = require('mime');


var pipelineConfig = {
    stackName: 'dromedary-serverless',
    region: 'us-west-2',
    cfnBucket: 'dromedary-serverless-templates',
    bucketPrefix: 'dromedary',
    ddbTableName: 'dromedary-serverless'
};

var s3             = new AWS.S3();

AWS.config.region = pipelineConfig.region
var cloudFormation = new AWS.CloudFormation();



gulp.task('clean', function(cb) {
    return del(['./dist', './dist.zip'],cb);
});

gulp.task('js', function() {
    return gulp.src(['index.js','lambda-adapter.js'])
        .pipe(gulp.dest('dist/'));
});

gulp.task('node-mods', function() {
    return gulp.src('./package.json')
        .pipe(gulp.dest('dist/'))
        .pipe(install({production: true}));
});

gulp.task('zipLambda', ['js','node-mods'], function() {
    return gulp.src(['!dist/package.json','!**/aws-sdk{,/**}','dist/**/*'])
        .pipe(zip('dist.zip'))
        .pipe(gulp.dest('./'));
});

gulp.task('uploadLambda',['zipLambda'], function(callback) {
    awsLambda.deploy('./dist.zip', require("./lambda-config.js"), callback);
});

gulp.task('s3empty:acpt', function(cb) {
    emptyBucket(pipelineConfig.bucketPrefix + '-acpt', cb);
});
gulp.task('s3empty:exp', function(cb) {
    emptyBucket(pipelineConfig.bucketPrefix + '-exp', cb);
});
gulp.task('s3empty:prod', function(cb) {
    emptyBucket(pipelineConfig.bucketPrefix + '-prod', cb);
});

gulp.task('s3:acpt', function(cb) {
    uploadToS3('node_modules/dromedary/public', pipelineConfig.bucketPrefix + '-acpt', cb);
});
gulp.task('s3:exp', function(cb) {
    uploadToS3('node_modules/dromedary/public', pipelineConfig.bucketPrefix + '-exp', cb);
});
gulp.task('s3:prod', function(cb) {
    uploadToS3('node_modules/dromedary/public', pipelineConfig.bucketPrefix + '-prod', cb);
});

gulp.task('deploy', function(cb) {
    return runSequence(
        ['clean'],
        ['uploadLambda'],
        cb
    )
});

gulp.task('deploy:acpt', function(cb) {
    return runSequence(
        ['clean'],
        ['zipLambda'],
        ['pipeline:waitForComplete'],
        ['s3:acpt'],
        cb
    )
});
gulp.task('deploy:exp', function(cb) {
    return runSequence(
        ['clean'],
        ['zipLambda'],
        ['pipeline:waitForComplete'],
        ['s3:exp'],
        cb
    )
});
gulp.task('deploy:prod', function(cb) {
    return runSequence(
        ['clean'],
        ['js'],
        ['node-mods'],
        ['pipeline:waitForComplete'],
        ['s3:prod'],
        cb
    )
});

gulp.task('pipeline:templatesBucket', function(cb) {
    s3.headBucket({ Bucket: pipelineConfig.cfnBucket }, function(err, data) {
        if (err) {
            if(err.statusCode == 404) {
                s3.createBucket({
                    Bucket: pipelineConfig.cfnBucket,
                    CreateBucketConfiguration: {
                        LocationConstraint: pipelineConfig.region
                    }
                }, function(err, data) {
                    if (err) {
                        cb(err);
                    } else {
                        console.log('Created bucket: '+pipelineConfig.cfnBucket);
                        cb();
                    }
                });
            } else {
                cb(err);
            }
        } else {
            console.log('Bucket already exists:'+ pipelineConfig.cfnBucket);
            cb();
        }
    });
});

gulp.task('pipeline:templates',['pipeline:templatesBucket'], function(cb) {
    uploadToS3('pipeline/cfn',pipelineConfig.cfnBucket, cb);
});

gulp.task('pipeline:up',['pipeline:templates'],  function() {
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
        var s3BucketURL = s3Endpoint+'/'+pipelineConfig.cfnBucket;

        var params = {
            StackName: pipelineConfig.stackName,
            Capabilities: ['CAPABILITY_IAM'],
            Parameters: [
                {
                    ParameterKey: "DDBTableName",
                    ParameterValue: pipelineConfig.ddbTableName
                },
                {
                    ParameterKey: "BaseTemplateURL",
                    ParameterValue: s3BucketURL+"/"
                },
                {
                    ParameterKey: "BucketPrefix",
                    ParameterValue: pipelineConfig.bucketPrefix
                },
            ],
            TemplateURL: s3BucketURL+"/dromedary-master.json"
        };

        cloudFormation[action](params, function(err) {
            if (err) {
                throw err;
            }
            var a = action === 'createStack' ? 'creation' : 'update';
            console.log('Stack ' + a + ' in progress. Run gulp pipeline:status to see current status.');
        });
    });
});

gulp.task('pipeline:down',['s3empty:acpt','s3empty:exp','s3empty:prod'], function() {
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

gulp.task('pipeline:waitForComplete', function(cb) {
    var stackName = pipelineConfig.stackName;
    var checkFunction = function() {
        getStack(stackName, function(err,stack) {
            if (err) {
                throw err;
            } else {
                if(!stack || stack.StackStatus == 'CREATE_IN_PROGRESS' || stack.StackStatus == 'UPDATE_IN_PROGRESS' || stack.StackStatus == 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS') {
                    console.log("      StackStatus = "+stack.StackStatus);
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
        console.log('Use gulp pipeline:log to view full event log');
        console.log('Use gulp pipeline:resources to view list of resources in the stack');
    });
});

gulp.task('pipeline:log', function() {
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

gulp.task('pipeline:resources', function() {
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

function getStack(stackName, cb) {
    cloudFormation.describeStacks({StackName: stackName}, function(err, data) {
        if (err) {
            return cb(err);
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
            cb(err);
        } else {

            var params = {
                Bucket: bucket,
                Delete: {
                    Objects: data.Contents
                }
            };
            s3.deleteObjects(params, function(err) {
                if (err) {
                    cb(err);
                } else {
                    cb();
                }
            });
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

