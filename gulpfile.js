var gulp        = require('gulp');
var gutil       = require('gulp-util');
var runSequence = require('run-sequence');
var app         = require('gulp-serverless-app');
var pipeline    = require('gulp-serverless-pipeline');

var jshint      = require('gulp-jshint'); // copied from dromedary
var mocha       = require('gulp-mocha'); // copied from dromedary

var stackName =  (gutil.env.stackName || 'dromedary-serverless');
var region = (gutil.env.region || 'us-west-2');

// add gulp tasks for app
app.registerTasks(gulp,{
    stackName: stackName,
    region: region,
    appSource: 'index.js',
    siteDirectory: 'node_modules/dromedary/public'
});

// add gulp tasks for pipeline
pipeline.registerTasks(gulp, {
    stackName: stackName + '-pipeline',
    region: region,

    githubToken: gutil.env.token,
    githubUser: 'stelligent',
    githubRepo: 'dromedary-serverless',
    githubBranch: 'master',

    gulpStaticAnalysisTask: 'lint',
    gulpUnitTestTask: 'test',
    gulpLaunchTask: 'app:up',
    gulpWaitForReadyTask: 'app:assertReady',
    gulpWaitForReadyRetries: '10',
    gulpDeployAppTask: 'app:lambda:upload',
    gulpDeploySiteTask: 'app:uploadSite',
    gulpDeployConfigTask: 'app:uploadConfig',
    gulpFunctionalTestTask: 'test-functional'
});


// Execute unit tests
gulp.task('test', function () {
    return gulp.src('node_modules/dromedary/test/*.js', {read: false})
        .pipe(mocha({reporter: 'spec'}));
});

gulp.task('setup-target-url', function (cb) {
    app.getStack()
        .then(function(stack) {
            var siteUrl = stack.Outputs.filter(function (o) { return o.OutputKey == 'SiteURL'})[0].OutputValue;
            process.env.TARGET_URL = siteUrl;
            console.log("TARGET_URL => "+process.env.TARGET_URL);
            cb();
        })
        .catch(cb);
});

// Execute functional tests
gulp.task('test-functional',['setup-target-url'], function (cb) {
    gulp.src('node_modules/dromedary/test-functional/*.js', {read: false})
        .pipe(mocha({reporter: 'spec'}));
});

// JSHint
gulp.task('lint-app', function() {
    return gulp.src(['node_modules/dromedary/app.js', 'node_modules/dromedary/lib/*.js'])
        .pipe(jshint())
        .pipe(jshint.reporter('default', { verbose: true }))
        .pipe(jshint.reporter('fail'));
});
gulp.task('lint-charthandler', function() {
    return gulp.src('node_modules/dromedary/public/charthandler.js')
        .pipe(jshint({ 'globals': { Chart: true, dromedaryChartHandler: true }}))
        .pipe(jshint.reporter('default', { verbose: true }))
        .pipe(jshint.reporter('fail'));
});
gulp.task('lint', function(callback) {
    runSequence(
        ['lint-app', 'lint-charthandler'],
        callback
    );
});





