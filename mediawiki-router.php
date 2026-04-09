<?php
/**
 * Router script for PHP's built-in web server to handle MediaWiki short URLs.
 * Usage: php -S 0.0.0.0:8082 mediawiki-router.php
 */

$root = __DIR__ . '/packages/mediawiki';
$uri  = $_SERVER['REQUEST_URI'];
$path = parse_url($uri, PHP_URL_PATH);

// Serve static files directly
$file = $root . $path;
if ($path !== '/' && is_file($file)) {
    return false; // let PHP's built-in server handle the file
}

// Short URL: /wiki/Page_title → index.php?title=Page_title
if (preg_match('#^/wiki/(.*)$#', $path, $m)) {
    $_GET['title'] = urldecode($m[1]);
    $_SERVER['PATH_INFO'] = '/wiki/' . $m[1];
    chdir($root);
    require $root . '/index.php';
    return;
}

// /wiki with no title → Main_Page
if ($path === '/wiki' || $path === '/wiki/') {
    $_GET['title'] = 'Main_Page';
    chdir($root);
    require $root . '/index.php';
    return;
}

// API endpoint
if (strpos($path, '/api.php') === 0 || $path === '/api.php') {
    chdir($root);
    require $root . '/api.php';
    return;
}

// REST API
if (strpos($path, '/rest.php') === 0) {
    chdir($root);
    require $root . '/rest.php';
    return;
}

// Default: serve index.php
chdir($root);
require $root . '/index.php';
