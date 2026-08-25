# Midiano

## A JavaScript MIDI-Player/ Piano-learning webapp

### [Try out here](https://midiano.com/)

Midiano is a free Piano-learning webapp that runs on any device with a modern browser.
Open any MIDI-File and Midiano shows you the notes as falling bars over a piano as well as the corresponding sheet music.
Connect a MIDI-Keyboard to get instant feedback if you hit the correct notes.
You can also use the keyboard as output device to play the MIDI-Files on your keyboard. 




![Screenshot](/screenShotNew.png)


I have continued development of Midiano in a private repository. This repository serves as a place for bug reports or feature requests.

I will keep the (outdated) code in this repository public though, in case someone is interested in looking at or tinkering with it. However please note that it is not open source.

The current version of the app can be accessed at [Midiano.com](https://midiano.com/). 

#### Browser Support :

It runs on any browser (and device) that supports the <a href='https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API#browser_compatibility'>WebAudioAPI</a> (Full support apart from Internet Explorer). 

To connect a MIDI-Keyboard the browser also needs to support the <a href='https://developer.mozilla.org/en-US/docs/Web/API/MIDIAccess#browser_compatibility'>WebMIDIAPI</a> (Currently only Chrome and Edge).

Bluetooth keyboards can also be connected straight from the Midi-Setup dialog, through the <a href='https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API#browser_compatibility'>WebBluetoothAPI</a> (Chrome on Android, Chrome and Edge on desktop). This is the only way to play along on Android: a BLE-MIDI keyboard paired in the system Bluetooth settings is not exposed to the WebMIDIAPI there — Android only surfaces it once an application opens the connection itself. Neither API is available on iOS/iPadOS.


#### Features :

- MIDI playback 
- MIDI-Keyboard support 
  - Input  - Let the song wait for you to hit the correct notes
  - Output - Use your MIDI-Keyboard as sound output
  - Bluetooth - Connect a BLE-MIDI keyboard from the Midi-Setup dialog, with automatic reconnection after a dropout
- Automatic Sheet Music generation (Formatting & Rendering done with VexFlow)
- Customize track colors, particle effects and track instruments
- 3 different soundfonts from https://github.com/gleitz/midi-js-soundfonts

#### Libraries used:

- pickr - Color Picker - https://github.com/Simonwep/pickr
- jQuery
- Bootstrap (only really use the glyphicons)
- VexFlow for Sheet formatting & rendering.
