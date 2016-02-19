'use strict'

var gulp        = require('gulp');
var gutil       = require('gulp-util');
var zip         = require('gulp-zip');
var del         = require('del');

var gpipeline   = require('.');

var pipelineConfig = {
    region: (gutil.env.region || 'us-west-2'),
    stackName: (gutil.env.stackName || 'dromedary-serverless'),
    githubToken: gutil.env.token,
    githubUser: 'stelligent',
    githubRepository: 'dromedary',
    githubBranch: 'config-api-baseurl'
};

gpipeline(gulp,pipelineConfig);


gulp.task('clean', function(cb) {
    return del(['dist'],cb);
});

gulp.task('dist',['pipeline:lambda:zip'], function() {
    return gulp.src(['index.js','package.json','cfn{,/**}','dist{,/codepipeline-gulp.zip}'])
        .pipe(zip('pipeline.zip'))
        .pipe(gulp.dest('dist'));
});

gulp.task('runAction',function(cb) {
    var lambda = require('./lambda');
    lambda.runAction(gutil.env.jobId,cb);
});




