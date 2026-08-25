/**
 * Decoder for BLE-MIDI packets ("MIDI over Bluetooth Low Energy" spec).
 *
 * A Bluetooth keyboard does not send raw MIDI messages: it wraps them in
 * timestamped packets.
 *
 *     [header] [timestamp] [midi message] ([timestamp] [midi message])*
 *
 * - header:    bit 7 set, bit 6 clear, bits 5-0 = high bits of the timestamp;
 * - timestamp: bit 7 set, bits 6-0 = low bits;
 * - message:   status byte (bit 7 set) followed by 0 to 2 data bytes (bit 7
 *              clear). The status byte may be omitted in "running status", in
 *              which case the timestamp usually is too.
 *
 * Timestamp bytes and status bytes therefore both have bit 7 set: only their
 * position in the packet tells them apart, hence the sequential decoding below
 * rather than a plain `slice`. Feeding the raw packet to a Web MIDI style
 * handler would read the header as the status byte and turn every keystroke
 * into garbage.
 */

/** Number of data bytes expected after a MIDI status byte. */
function dataByteCount(status) {
	switch (status & 0xf0) {
		case 0x80: // note off
		case 0x90: // note on
		case 0xa0: // polyphonic aftertouch
		case 0xb0: // control change
		case 0xe0: // pitch bend
			return 2
		case 0xc0: // program change
		case 0xd0: // channel aftertouch
			return 1
		case 0xf0:
			// System messages: 0xF1/0xF3 take one byte, 0xF2 two, the rest none.
			if (status == 0xf2) {
				return 2
			}
			return status == 0xf1 || status == 0xf3 ? 1 : 0
		default:
			return 0
	}
}

/**
 * Extracts the MIDI messages of a BLE-MIDI packet, as an array of Uint8Array.
 * SysEx is not supported (it spans several packets and MIDIano has no use for
 * it): decoding stops at the first 0xF0 encountered.
 */
export function parseBleMidiPacket(packet) {
	let messages = []
	// A useful packet holds at least a header, a timestamp and a status byte.
	if (!packet || packet.length < 3) {
		return messages
	}

	let runningStatus = 0
	let i = 1 // skip the header

	while (i < packet.length) {
		// Timestamp byte, present before every message except in running status.
		if (packet[i] & 0x80) {
			i++
		}
		if (i >= packet.length) {
			break
		}

		let status
		if (packet[i] & 0x80) {
			status = packet[i]
			i++
			if (status == 0xf0) {
				break // SysEx: give up on the rest of the packet
			}
			if (status < 0xf0) {
				runningStatus = status
			} else if (status < 0xf8) {
				runningStatus = 0 // system common messages cancel running status
			}
			// Real-time messages (>= 0xF8) leave the running status untouched.
		} else if (runningStatus) {
			status = runningStatus
		} else {
			break // data byte with no known status: unreadable packet
		}

		let count = dataByteCount(status)
		if (i + count > packet.length) {
			break // truncated packet
		}
		let message = new Uint8Array(1 + count)
		message[0] = status
		message.set(packet.subarray(i, i + count), 1)
		messages.push(message)
		i += count
	}

	return messages
}
