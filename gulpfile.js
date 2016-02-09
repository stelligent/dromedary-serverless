var gulp        = require('gulp');
var zip        = require('gulp-zip');
var install     = require('gulp-install');
var del         = require('del');
var runSequence = require('run-sequence');
var jshint      = require('gulp-jshint');
var awsLambda = require("node-aws-lambda");


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

gulp.task('zip', function() {
    return gulp.src(['!dist/package.json','!**/aws-sdk{,/**}','dist/**/*'])
        .pipe(zip('dist.zip'))
        .pipe(gulp.dest('./'));
});

gulp.task('upload', function(callback) {
    awsLambda.deploy('./dist.zip', require("./lambda-config.js"), callback);
});

gulp.task('deploy', function(cb) {
    return runSequence(
        ['clean'],
        ['js'],
        ['node-mods'],
        ['zip'],
        ['upload'],
        cb
    )
});