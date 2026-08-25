import { parseBleMidiPacket } from "./BleMidiPacket.js"

/** UUIDs from the "MIDI over Bluetooth Low Energy" specification. */
const BLE_MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700"
const BLE_MIDI_CHARACTERISTIC = "7772e5db-3868-4112-a1a9-f2669d106bf3"

/** Source key of the notes coming from the BLE connection we opened ourselves. */
const BLE_SOURCE = "ble"

/** Backoff between automatic reconnection attempts after a Bluetooth dropout. */
const BLE_RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000]

class MidiInputHandler {
	constructor() {
		// patch up prefixes
		window.AudioContext = window.AudioContext || window.webkitAudioContext

		this.noMidiMessage =
			"You will only be able to play Midi-Files. To play along, you need to use a browser with Midi-support, connect a Midi-Device to your computer and reload the page."

		/**
		 * Notes currently held, note number -> key of the source that started
		 * them. Serves two purposes: dropping the duplicate note-on of a keyboard
		 * exposed on two ports, and releasing whatever a vanishing device left
		 * held (its note-offs will never arrive).
		 */
		this.heldNotes = new Map()

		/**
		 * Names of the input ports the user switched on. A Bluetooth keyboard
		 * comes back as a *different* port (new id) after every re-pairing, so the
		 * id alone cannot tell us the user already chose that keyboard.
		 */
		this.activeInputNames = new Set()

		this.bleDevice = null
		this.bleDeviceName = null
		this.bleCharacteristic = null
		this.bleError = null
		this.bleConnecting = false
		this.bleReconnectTimeout = null
		this.bleReconnectAttempt = 0
		// Kept as fields: `removeEventListener` only matches the *same* function
		// reference, and we do need to remove these on reconnection (see below).
		this.bleNotificationHandler = this.onBleNotification.bind(this)
		this.bleDisconnectHandler = this.onBleDisconnected.bind(this)

		this.init()
	}
	init() {
		if (navigator.requestMIDIAccess)
			navigator
				.requestMIDIAccess()
				.then(this.onMIDIInit.bind(this), this.onMIDIReject.bind(this))
		else if (!this.isBluetoothSupported())
			// Chrome on Android has Web Bluetooth but no Web MIDI: BLE keyboards
			// still work there, so don't scare the user away in that case.
			alert(
				"No MIDI support present in your browser.  Check https://developer.mozilla.org/en-US/docs/Web/API/MIDIAccess#Browser_compatibility to see which Browsers support this feature."
			)
	}
	getAvailableInputDevices() {
		try {
			return Array.from(this.midiAccess.inputs.values()).filter(
				// Unplugged ports stay in `midiAccess.inputs` with the state
				// "disconnected" (the browser keeps them around to reuse the same
				// object on reconnection). Without this filter a Bluetooth keyboard
				// shows up once per pairing, and all but the last entry are dead
				// ghosts that will never emit a single note.
				device => device.state == "connected"
			)
		} catch (e) {
			return []
		}
	}
	getAvailableOutputDevices() {
		try {
			return Array.from(this.midiAccess.outputs.values()).filter(
				device => device.state == "connected"
			)
		} catch (e) {
			return []
		}
	}
	setNoteOnCallback(callback) {
		this.noteOnCallback = callback
	}
	setNoteOffCallback(callback) {
		this.noteOffCallback = callback
	}
	/** Called whenever the device list or the Bluetooth state changed. */
	setDeviceChangeCallback(callback) {
		this.deviceChangeCallback = callback
	}
	addInput(device) {
		device.onmidimessage = this.MIDIMessageEventHandler.bind(this)
		if (device.name) {
			this.activeInputNames.add(device.name)
		}
	}
	clearInput(device) {
		device.onmidimessage = null
		if (device.name) {
			this.activeInputNames.delete(device.name)
		}
		this.releaseNotesFrom(this.getSourceKey(device))
	}
	addOutput(device) {
		this.activeOutput = device
	}
	clearOutput(device) {
		if (this.activeOutput == device) {
			this.activeOutput = null
		}
	}
	clearInputs() {
		Array.from(this.midiAccess.inputs.values()).forEach(
			device => (device.onmidimessage = null)
		)
		this.activeInputNames.clear()
		// Every port note is now orphaned - including those a ghost port left
		// behind, which no longer appears in the list above. The Bluetooth
		// connection is untouched, so its notes stay held.
		this.heldNotes.forEach((sourceKey, noteNumber) => {
			if (sourceKey != BLE_SOURCE) {
				this.heldNotes.delete(noteNumber)
				this.noteOffCallback(noteNumber)
			}
		})
	}
	isDeviceActive(device) {
		return device.onmidimessage != null
	}
	isOutputDeviceActive(device) {
		return this.activeOutput == device
	}
	onMIDIInit(midi) {
		this.midiAccess = midi
		midi.onstatechange = this.onMIDIStateChange.bind(this)
	}
	/**
	 * A device was plugged in, unplugged, or (re-)paired. Two things have to
	 * happen here, or playing along silently stops working after a Bluetooth
	 * dropout: re-attach the keyboard the user had already chosen, and release
	 * the notes the vanished port left hanging.
	 */
	onMIDIStateChange(event) {
		let port = event.port
		if (port && port.type == "input") {
			if (port.state == "connected") {
				// Re-attach by name: the port that just appeared is a brand new
				// object with a new id, so nothing else links it to the entry the
				// user clicked before the keyboard went away.
				if (!this.isDeviceActive(port) && this.activeInputNames.has(port.name)) {
					port.onmidimessage = this.MIDIMessageEventHandler.bind(this)
				}
			} else {
				// MIDIano's input notes are continuous audio nodes: a note-on whose
				// note-off never comes rings forever.
				this.releaseNotesFrom(this.getSourceKey(port))
				port.onmidimessage = null
			}
		}
		this.deviceChangeCallback()
	}
	onMIDIReject(err) {
		alert("The MIDI system failed to start. " + this.noMidiMessage)
	}

	/** Identifies the origin of a note, to release the right ones on a dropout. */
	getSourceKey(device) {
		return "port:" + device.id
	}

	MIDIMessageEventHandler(event) {
		this.handleMidiData(
			event.data,
			event.target ? this.getSourceKey(event.target) : "port"
		)
	}

	/**
	 * Handles one raw MIDI message, whatever its origin: a Web MIDI port (USB, or
	 * Bluetooth paired at the OS level) or the BLE-MIDI connection MIDIano opened
	 * itself over Web Bluetooth.
	 */
	handleMidiData(data, sourceKey) {
		if (!data || data.length < 2) {
			return
		}
		// Mask off the lower nibble (MIDI channel, which we don't care about)
		let status = data[0] & 0xf0
		let noteNumber = parseInt(data[1]) - 21
		let velocity = data.length > 2 ? data[2] : 0

		if (status == 0x90 && velocity != 0) {
			// A keyboard exposed on two ports at once (USB *and* Bluetooth, which
			// happens as soon as both are connected) sends every keystroke twice:
			// without this guard the note is played and scored twice. A genuine
			// re-press is always preceded by a note-off, so a held note is never
			// legitimately pressed again.
			if (this.heldNotes.has(noteNumber)) {
				return
			}
			this.heldNotes.set(noteNumber, sourceKey)
			this.noteOnCallback(noteNumber)
		} else if (status == 0x80 || (status == 0x90 && velocity == 0)) {
			// Some keyboards send a note-on with velocity 0 instead of a note-off.
			if (!this.heldNotes.has(noteNumber)) {
				return
			}
			this.heldNotes.delete(noteNumber)
			this.noteOffCallback(noteNumber)
		}
	}

	/** Releases every note started by `sourceKey` (all of them if omitted). */
	releaseNotesFrom(sourceKey) {
		this.heldNotes.forEach((key, noteNumber) => {
			if (sourceKey == null || key == sourceKey) {
				this.heldNotes.delete(noteNumber)
				this.noteOffCallback(noteNumber)
			}
		})
	}

	getActiveMidiOutput() {
		return this.activeOutput
	}
	isOutputActive() {
		return this.activeOutput ? true : false
	}
	isInputActive() {
		if (this.isBluetoothConnected()) {
			return true
		}
		let devices = this.getAvailableInputDevices()
		for (let i = 0; i < devices.length; i++) {
			if (this.isDeviceActive(devices[i])) {
				return true
			}
		}
		return false
	}
	playNote(noteNumber, velocity, noteOffVelocity, delayOn, delayOff) {
		let noteOnEvent = [0x90, noteNumber, velocity]
		let noteOffEvent = [0x80, noteNumber, noteOffVelocity]
		this.activeOutput.send(noteOnEvent, window.performance.now() + delayOn)
		this.activeOutput.send(noteOffEvent, window.performance.now() + delayOff)
	}
	midiOutNoteOff() {}
	noteOnCallback() {}
	noteOffCallback() {}
	deviceChangeCallback() {}

	// --- BLE-MIDI over Web Bluetooth ----------------------------------------
	//
	// On Android a Bluetooth keyboard paired in the system settings does NOT show
	// up in Web MIDI: Android only exposes a BLE-MIDI device once an application
	// opens the GATT connection itself (which is why Roland's manuals ask you to
	// *not* pair the piano from the Bluetooth settings). No OS-level setting can
	// make it work, so the page has to open the connection - that is what Web
	// Bluetooth is for, available in Chrome on Android and Chrome/Edge on desktop.
	// Same story on Linux, where BLE-MIDI never reaches ALSA.

	isBluetoothSupported() {
		return typeof navigator != "undefined" && navigator.bluetooth != null
	}
	isBluetoothConnected() {
		return this.bleCharacteristic != null
	}
	/** True while an automatic reconnection is pending or in flight. */
	isBluetoothReconnecting() {
		return (
			this.bleDevice != null &&
			!this.isBluetoothConnected() &&
			(this.bleReconnectTimeout != null || this.bleConnecting)
		)
	}
	/** Name of the keyboard we are connected to (or trying to get back). */
	getBluetoothDeviceName() {
		return this.bleDeviceName
	}
	getBluetoothError() {
		return this.bleError
	}
	/** True once a keyboard has been picked: it can be retried without a chooser. */
	hasBluetoothDevice() {
		return this.bleDevice != null
	}

	/**
	 * Opens the browser's Bluetooth chooser and connects a BLE-MIDI keyboard.
	 * Must be called from a user gesture (a click), otherwise the browser refuses
	 * to show the chooser. Resolves to false when the user dismissed the chooser,
	 * true once connected, and rejects on an actual failure.
	 */
	async connectBluetoothMidi() {
		if (!this.isBluetoothSupported()) {
			throw new Error(
				"This browser has no Web Bluetooth support. Use Chrome on Android or on desktop, or connect the keyboard over USB."
			)
		}
		let device
		try {
			device = await navigator.bluetooth.requestDevice({
				filters: [{ services: [BLE_MIDI_SERVICE] }],
				optionalServices: [BLE_MIDI_SERVICE]
			})
		} catch (e) {
			// "NotFoundError" also covers "the user closed the chooser": the chooser
			// reports an empty device list itself, no need to shout on top of it.
			if (e && e.name == "NotFoundError") {
				return false
			}
			throw e
		}

		// Picking another keyboard: drop the previous one first, listeners included.
		if (this.bleDevice && this.bleDevice != device) {
			this.disconnectBluetoothMidi()
		}
		this.cancelBleReconnect()
		this.bleDevice = device
		this.bleDeviceName = device.name || "Bluetooth keyboard"
		this.bleError = null
		// The chooser hands back the same BluetoothDevice object for a device that
		// was already picked, so drop a possibly already-registered listener rather
		// than running the reconnection logic twice on the next dropout.
		device.removeEventListener(
			"gattserverdisconnected",
			this.bleDisconnectHandler
		)
		device.addEventListener("gattserverdisconnected", this.bleDisconnectHandler)
		try {
			await this.attachBleCharacteristic(device)
		} catch (e) {
			this.bleError = "Could not connect the Bluetooth keyboard."
			this.deviceChangeCallback()
			throw e
		}
		this.deviceChangeCallback()
		return true
	}

	/**
	 * Opens the GATT connection and subscribes to the MIDI characteristic. Used
	 * both for the first connection and for every reconnection: everything below
	 * the device object goes stale on a dropout, so the whole chain (server,
	 * service, characteristic, notifications) has to be rebuilt - reusing the old
	 * characteristic just throws "GATT Server is disconnected".
	 */
	async attachBleCharacteristic(device) {
		if (this.bleConnecting) {
			return
		}
		this.bleConnecting = true
		try {
			if (!device.gatt) {
				throw new Error("GATT is not available on this device.")
			}
			// Note: on a device that is out of range this call stays pending until
			// the keyboard advertises again, instead of rejecting. That is exactly
			// what we want here (the connection comes back on its own when the
			// keyboard is switched back on), but it is also why concurrent calls
			// have to be kept out - hence the flag above.
			let server = await device.gatt.connect()
			let service = await server.getPrimaryService(BLE_MIDI_SERVICE)
			let characteristic = await service.getCharacteristic(
				BLE_MIDI_CHARACTERISTIC
			)
			await characteristic.startNotifications()
			// Chrome hands back the *same* characteristic object on reconnection:
			// adding the listener without removing it first makes every note fire
			// twice after one dropout, three times after two, and so on.
			characteristic.removeEventListener(
				"characteristicvaluechanged",
				this.bleNotificationHandler
			)
			characteristic.addEventListener(
				"characteristicvaluechanged",
				this.bleNotificationHandler
			)
			this.bleCharacteristic = characteristic
			this.bleReconnectAttempt = 0
			this.bleError = null
		} finally {
			this.bleConnecting = false
		}
	}

	onBleNotification(event) {
		let value = event.target.value
		if (!value) {
			return
		}
		let packet = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
		parseBleMidiPacket(packet).forEach(message =>
			this.handleMidiData(message, BLE_SOURCE)
		)
	}

	onBleDisconnected() {
		this.bleCharacteristic = null
		// The keyboard vanished mid-chord: its note-offs will never arrive and the
		// input notes are continuous audio nodes, so they would ring forever.
		this.releaseNotesFrom(BLE_SOURCE)
		// The permission survives the dropout, so reconnecting needs no new user
		// gesture - the keyboard just has to come back. Schedule before redrawing,
		// so the dialog says "Reconnecting…" instead of flashing the manual
		// Reconnect button for the whole length of the attempt.
		this.scheduleBleReconnect()
		this.deviceChangeCallback()
	}

	scheduleBleReconnect() {
		if (!this.bleDevice || this.bleReconnectTimeout != null) {
			return
		}
		let delay =
			BLE_RECONNECT_DELAYS[
				Math.min(this.bleReconnectAttempt, BLE_RECONNECT_DELAYS.length - 1)
			]
		this.bleReconnectAttempt++
		this.bleReconnectTimeout = window.setTimeout(async () => {
			this.bleReconnectTimeout = null
			let device = this.bleDevice
			if (!device) {
				return // disconnected by hand in the meantime
			}
			try {
				await this.attachBleCharacteristic(device)
			} catch (e) {
				if (this.bleReconnectAttempt < BLE_RECONNECT_DELAYS.length) {
					this.scheduleBleReconnect()
				} else {
					this.bleError =
						"Bluetooth connection lost. Switch the keyboard back on, then press Reconnect."
				}
			}
			this.deviceChangeCallback()
		}, delay)
	}

	cancelBleReconnect() {
		if (this.bleReconnectTimeout != null) {
			window.clearTimeout(this.bleReconnectTimeout)
			this.bleReconnectTimeout = null
		}
		this.bleReconnectAttempt = 0
	}

	/**
	 * Retries the connection to the keyboard already picked, without reopening the
	 * chooser: the Bluetooth permission is granted for good, only the link is
	 * gone. Lets the user get back in after the automatic attempts gave up.
	 */
	async reconnectBluetoothMidi() {
		if (!this.bleDevice || this.isBluetoothConnected()) {
			return
		}
		this.cancelBleReconnect()
		this.bleError = null
		this.deviceChangeCallback()
		try {
			await this.attachBleCharacteristic(this.bleDevice)
		} catch (e) {
			this.bleError =
				"Could not reconnect. Make sure the keyboard is switched on and in range."
		}
		this.deviceChangeCallback()
	}

	/** Closes the BLE-MIDI connection opened by `connectBluetoothMidi`. */
	disconnectBluetoothMidi() {
		this.cancelBleReconnect()
		if (this.bleCharacteristic) {
			this.bleCharacteristic.removeEventListener(
				"characteristicvaluechanged",
				this.bleNotificationHandler
			)
			this.bleCharacteristic = null
		}
		if (this.bleDevice) {
			// Drop the disconnect listener *before* disconnecting, otherwise our own
			// disconnect fires it and the automatic reconnection immediately brings
			// back the keyboard the user just asked to let go of.
			this.bleDevice.removeEventListener(
				"gattserverdisconnected",
				this.bleDisconnectHandler
			)
			if (this.bleDevice.gatt && this.bleDevice.gatt.connected) {
				this.bleDevice.gatt.disconnect()
			}
			this.bleDevice = null
		}
		this.bleDeviceName = null
		this.bleError = null
		this.releaseNotesFrom(BLE_SOURCE)
		this.deviceChangeCallback()
	}
}
const theMidiHandler = new MidiInputHandler()
export const getMidiHandler = () => {
	return theMidiHandler
}
