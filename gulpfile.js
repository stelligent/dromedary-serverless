var gulp        = require('gulp');
var gutil       = require('gulp-util');
var runSequence = require('run-sequence');
var app         = require('gulp-serverless-app');
var pipeline    = require('gulp-serverless-pipeline');

var jshint      = require('gulp-jshint'); // copied from dromedary
var mocha       = require('gulp-mocha'); // copied from dromedary
var pjson       = require('./package.json');


var appName    = pjson.name;
var appVersion = pjson.version;
var stackName  = (gutil.env.stackName || appName);
var cfnBucket  = (gutil.env.templateBucket || 'dromedary-serverless-templates');
var region = (gutil.env.region || process.env.AWS_DEFAULT_REGION || 'us-west-2');


// if a PIPELINE_NAME is used, then append it to the stackName
try {
    var stackNameSuffix = process.env.PIPELINE_NAME.match(/-([^-]+)$/g)[0];
    if(stackNameSuffix) {
        stackName += stackNameSuffix
    }
} catch (e) {}
stackName = stackName.toLowerCase();

console.log("APP NAME    = "+appName);
console.log("APP VERSION = "+appVersion);
console.log("STACK NAME  = "+stackName);
console.log("REGION      = "+region);


// add gulp tasks for app
app.registerTasks(gulp,{
    stackName: stackName,
    region: region,
    cfnBucket: cfnBucket,

    applicationName: appName,
    applicationVersion: appVersion,
    appSource: 'index.js',
    siteDirectory: 'node_modules/dromedary/public'
});

// add gulp tasks for pipeline
pipeline.registerTasks(gulp, {
    stackName: stackName + '-pipeline',
    region: region,
    cfnBucket: cfnBucket,

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
    gulpFunctionalTestTask: 'test-functional',
    gulpProductionDNSTask: 'prodDNS'
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

gulp.task('prodDNS',function() {
})


