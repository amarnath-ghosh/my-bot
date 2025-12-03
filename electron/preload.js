"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var electron_1 = require("electron");
// Define the API that will be exposed to the renderer
var electronAPI = {
    joinMeeting: function (url) { return electron_1.ipcRenderer.invoke('join-meeting', url); },
    getSources: function () { return electron_1.ipcRenderer.invoke('get-sources'); },
    closeMeeting: function () { return electron_1.ipcRenderer.invoke('close-meeting'); },
    onTranscriptUpdate: function (callback) {
        var subscription = function (event, data) { return callback(data); };
        electron_1.ipcRenderer.on('transcript-update', subscription);
    },
    removeTranscriptListener: function () {
        electron_1.ipcRenderer.removeAllListeners('transcript-update');
    }
};
// Expose the API to the renderer process
electron_1.contextBridge.exposeInMainWorld('electronAPI', electronAPI);
