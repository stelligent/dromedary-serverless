'use strict'

var gulp        = require('gulp');
var gutil       = require('gulp-util');
var gcallback   = require('gulp-callback');
var install     = require('gulp-install');
var zip         = require('gulp-zip');
var del         = require('del');
var AWS         = require('aws-sdk');
var fs          = require('fs');
var runSequence = require('run-sequence');


var opts = {
    region: (gutil.env.region || 'us-west-2'),
    stackName: (gutil.env.stackName || 'dromedary-serverless'),
    cfnBucket: (gutil.env.templateBucket || 'dromedary-serverless-templates'),
    testSiteFQDN: 'drom-test.elasticoperations.com',
    prodSiteFQDN: 'drom-prod.elasticoperations.com',
    hostedZoneId: 'Z3809G91N7QZJE', //TODO: get this programatically
    distSitePath: 'dist/site.zip',
    distLambdaPath: 'dist/lambda.zip',
    distSwaggerPath: 'dist/swagger.json',
    gulpTestTask: 'test-functional',
    gulpPackageTask: 'package',
    githubToken: gutil.env.token,
    githubUser: 'stelligent',
    githubRepo: 'dromedary',
    githubBranch: 'serverless'
}
var util = require('./pipeline/util.js')
var gpipeline = require('./pipeline')
gpipeline.registerTasks(gulp,opts);

var lambda      = new AWS.Lambda();
var s3          = new AWS.S3();
var dist        = 'dist';


gulp.task('lambda:clean', function(cb) {
    return del([dist],{force: true}, cb);
});

gulp.task('lambda:js', function() {
    return gulp.src([__dirname+'/pipeline/lambda/index.js'])
        .pipe(gulp.dest(dist+'/lambda/'));
});

gulp.task('lambda:install', function() {
    return gulp.src(__dirname+'/pipeline/lambda/package.json')
        .pipe(gulp.dest(dist+'/lambda/'))
        .pipe(install({production: true}));
});

gulp.task('lambda:zip', ['lambda:js','lambda:install'], function() {
    return gulp.src(['!'+dist+'/lambda/package.json','!'+dist+'/**/aws-sdk{,/**}',dist+'/lambda/**/*'])
        .pipe(zip('pipeline-lambda.zip'))
        .pipe(gulp.dest(dist));
});

gulp.task('lambda:upload', ['lambda:gulpUpload', 'lambda:npmUpload']);

gulp.task('lambda:gulpUpload', ['lambda:zip'], function() {
    return uploadLambda('CodePipelineGulpLambdaArn');
});
gulp.task('lambda:deployUpload', ['lambda:zip'], function() {
    return uploadLambda('CodePipelineDeployLambdaArn');
});
gulp.task('lambda:npmUpload', ['lambda:zip'], function() {
    return uploadLambda('CodePipelineNpmLambdaArn');
});


// Tasks to provision the pipeline
gulp.task('cfn:templatesBucket', function(cb) {
    s3.headBucket({ Bucket: opts.cfnBucket }, function(err, data) {
        if (err) {
            if(err.statusCode == 404) {
                s3.createBucket({
                    Bucket: opts.cfnBucket,
                    CreateBucketConfiguration: {
                        LocationConstraint: opts.region
                    }
                }, function(err, data) {
                    if (err) {
                        cb(err);
                    } else {
                        console.log('Created bucket: '+opts.cfnBucket);
                        cb();
                    }
                });
            } else {
                cb(err);
            }
        } else {
            console.log('Bucket already exists:'+ opts.cfnBucket);
            cb();
        }
    });
});

gulp.task('cfn:templates',['cfn:templatesBucket'], function() {
    return util.uploadToS3(__dirname+'/pipeline/cfn',opts.cfnBucket);
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

    var complete = 0;
    lambdaModules.forEach(function (moduleName) {
        gulp.src([__dirname+'/node_modules/'+moduleName+'/**/*','!'+__dirname+'node_modules/'+moduleName+'/package.json','!**/aws-sdk{,/**}'])
            .pipe(zip(moduleName+'.zip'))
            .pipe(gulp.dest(dist))
            .pipe(gcallback(function(err) {
                if (err) {
                    cb(err);
                } else {
                    var params = {
                        Bucket: opts.cfnBucket,
                        Key: moduleName + '.zip',
                        ACL: 'public-read',
                        Body: fs.readFileSync(dist+"/"+moduleName +'.zip')
                    }

                    s3.putObject(params, function (err, data) {
                        if (err) {
                            cb(err);
                        } else {
                            if (++complete >= lambdaModules.length) {
                                cb();
                            }
                        }
                    });
                }
            }));
    });
});


gulp.task('lambda:uploadS3', ['lambda:zip','cfn:templatesBucket'], function(cb) {
    var path = dist+'/pipeline-lambda.zip';
    var params = {
        Bucket: opts.cfnBucket,
        Key: 'pipeline-lambda.zip',
        ACL: 'public-read',
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

gulp.task('publish',['cfn:templates','cfn:customResources','lambda:uploadS3'],  function() {
});

gulp.task('launch',['publish'],  function(callback) {
    runSequence('pipeline:up',callback);
});

function uploadLambda(lambdaArnOutputKey) {
    return util.getSubStackOutput(opts.stackName,'PipelineStack',lambdaArnOutputKey)
        .then(function(pipelineFunctionArn) {
            var params = {
                FunctionName: pipelineFunctionArn,
                Publish: true,
                ZipFile: fs.readFileSync(dist + '/pipeline-lambda.zip')
            };

            console.log("About to update function..." + pipelineFunctionArn);

            return new Promise(function (resolve, reject) {
                lambda.updateFunctionCode(params, function (err, data) {
                    if (err) {
                        reject(err);
                    } else {
                        console.log("Updated lambda to version: " + data.Version);
                        resolve();
                    }
                });
            });
        });
}


