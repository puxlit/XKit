"use strict";

/* globals chrome */

const CSS_TO_INJECT = [
	"/xkit.css",
];
const JS_TO_INJECT = [
	"/bridge.js",
	"/lodash.min.js",
	"/jquery.js",
	"/tiptip.js",
	"/moment.js",
	"/nano.js",
	"/xkit.js",
];
const COMMON_INJECT_DETAILS = {
	allFrames: false,
	matchAboutBlank: false,
	runAt: "document_end",
};

function inject(tabId, frameId) {
	for (const file of CSS_TO_INJECT) {
		chrome.tabs.insertCSS(tabId, {file, frameId, ...COMMON_INJECT_DETAILS});
	}
	for (const file of JS_TO_INJECT) {
		chrome.tabs.executeScript(tabId, {file, frameId, ...COMMON_INJECT_DETAILS});
	}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message === 418) {
		inject(sender.tab.id, sender.frameId);
	}
});
