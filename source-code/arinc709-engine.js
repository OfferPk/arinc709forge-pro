/**
 * ARINC709Forge Pro (v1.0.0) - Core Distance Measuring Equipment (DME) Engine
 * Mark 5 Airborne Distance Measuring Equipment (ARINC Characteristic 709A & ICAO Annex 10 Vol I)
 * 
 * Normative References:
 * - ARINC Characteristic 709A (Mark 5 Airborne Distance Measuring Equipment)
 * - ICAO Annex 10, Volume I (Radio Navigation Aids - Chapter 3.5 UHF Distance Measuring Equipment)
 * - FAA TSO-C66c / EASA ETSO-2C66b (Distance Measuring Equipment Operating Within 960-1215 MHz)
 * - RTCA DO-189 (Minimum Operational Performance Standards for Airborne DME Equipment)
 * - ARINC Specification 429 (Mark 33 Digital Information Transfer System)
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ARINC709Engine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Constant definitions
  const RADAR_MILE_US_PER_NM = 12.3592; // Microseconds of round-trip propagation delay per nautical mile
  const SPEED_OF_LIGHT_KM_S = 299792.458;
  const NM_TO_METERS = 1852.0;

  const ARINC429_LABELS = {
    DME_TUNING: 0o035,       // Label 035 - DME Frequency / Channel Tuning Word (BCD)
    DME_DISTANCE: 0o201,     // Label 201 - DME Distance / Slant Range (BNR)
    DME_TIME_SPEED: 0o202,   // Label 202 - DME Groundspeed / Time-to-Station (BNR)
    DME_STATUS: 0o270,       // Label 270 - DME Discrete Status & Operating Mode
    DME_FAULT: 0o350         // Label 350 - Maintenance & Fault BITE Word
  };

  const DME_MODES = {
    SEARCH: 'SEARCH (Acquisition PRF 150 pps)',
    TRACK: 'TRACK (Tracking PRF 25-30 pps)',
    MEMORY: 'MEMORY HOLD (Coast 10s Window)',
    SELF_TEST: 'SELF-TEST (BITE Diagnostic)',
    STANDBY: 'STANDBY (RF Transmitter Inhibited)'
  };

  const MORSE_MAP = {
    'A': '.-',    'B': '-...',  'C': '-.-.',  'D': '-..',
    'E': '.',     'F': '..-.',  'G': '--.',   'H': '....',
    'I': '..',    'J': '.---',  'K': '-.-',   'L': '.-..',
    'M': '--',    'N': '-.',    'O': '---',   'P': '.--.',
    'Q': '--.-',  'R': '.-.',   'S': '...',   'T': '-',
    'U': '..-',   'V': '...-',  'W': '.--',   'X': '-..-',
    'Y': '-.--',  'Z': '--..'
  };

  /**
   * Helper: Calculate ARINC 429 Bit 32 Odd Parity
   */
  function calculateParity(word31Bits) {
    let count = 0;
    for (let i = 0; i < 31; i++) {
      if ((word31Bits >>> i) & 1) {
        count++;
      }
    }
    return (count % 2 === 0) ? 1 : 0;
  }

  /**
   * Helper: Reverse 8-bit octal label to ARINC 429 transmission order
   */
  function reverseLabelBits(octalLabel) {
    let reversed = 0;
    for (let i = 0; i < 8; i++) {
      reversed = (reversed << 1) | ((octalLabel >> i) & 1);
    }
    return reversed;
  }

  /**
   * Helper: Encode a full ARINC 429 32-bit word with Bit 32 Odd Parity
   */
  function encodeARINC429Word(octalLabel, sdi, dataBits, ssm) {
    const revLabel = reverseLabelBits(octalLabel) & 0xFF;
    const sdiField = (sdi & 0x03) << 8;
    const dataField = (dataBits & 0x7FFFF) << 10;
    const ssmField = (ssm & 0x03) << 29;

    let word = revLabel | sdiField | dataField | ssmField;
    const parity = calculateParity(word);
    word |= (parity << 31);
    return word >>> 0;
  }

  /**
   * Helper: Decode an ARINC 429 32-bit word
   */
  function decodeARINC429Word(word32) {
    const parity = (word32 >>> 31) & 1;
    const wordWithoutParity = word32 & 0x7FFFFFFF;
    const expectedParity = calculateParity(wordWithoutParity);
    const parityValid = (parity === expectedParity);

    const ssm = (word32 >>> 29) & 0x03;
    const data = (word32 >>> 10) & 0x7FFFF;
    const sdi = (word32 >>> 8) & 0x03;
    const rawLabel = word32 & 0xFF;

    let octalLabel = 0;
    for (let i = 0; i < 8; i++) {
      octalLabel = (octalLabel << 1) | ((rawLabel >> i) & 1);
    }

    const ssmMeaning = (ssm === 0x03) ? 'Normal Operation' :
                       (ssm === 0x00) ? 'Failure Warning' :
                       (ssm === 0x01) ? 'No Computed Data (NCD)' : 'Functional Test';

    return {
      wordHex: '0x' + word32.toString(16).toUpperCase().padStart(8, '0'),
      octalLabel: '0' + octalLabel.toString(8).padStart(3, '0'),
      sdi,
      data,
      ssm,
      ssmMeaning,
      parityValid
    };
  }

  /**
   * VHF to DME Channel & UHF Frequency Mapping
   * VHF 108.00 - 117.95 MHz paired to UHF 962 - 1213 MHz
   */
  function pairVhfToDmeChannel(vhfFreqMhz) {
    const freqKhz = Math.round(vhfFreqMhz * 1000);
    const baseKhz = 108000;
    const offsetKhz = freqKhz - baseKhz;
    const channelIndex = Math.floor(offsetKhz / 100) + 1; // 1 to 100+
    
    // Determine X or Y channel: even 50 kHz tenths are X, odd 50 kHz are Y
    const isY = (Math.round((freqKhz % 100) / 10) === 5);
    const channelNum = Math.max(1, Math.min(126, channelIndex));
    const channelSuffix = isY ? 'Y' : 'X';
    const channelName = `${channelNum}${channelSuffix}`;

    // UHF frequencies: Interrogation (TX) and Reply (RX)
    let txFreqMhz = 1025 + channelNum;
    let rxFreqMhz = isY ? (txFreqMhz - 63) : (txFreqMhz + 63);
    if (rxFreqMhz > 1213) rxFreqMhz -= 126;
    if (rxFreqMhz < 962) rxFreqMhz += 126;

    const pulseSpacingTxUs = isY ? 36.0 : 12.0;
    const pulseSpacingRxUs = isY ? 30.0 : 12.0;
    const transponderDelayUs = isY ? 56.0 : 50.0;

    return {
      vhfFreqMhz: parseFloat(vhfFreqMhz.toFixed(2)),
      channel: channelName,
      channelNum,
      suffix: channelSuffix,
      interrogationFreqMhz: txFreqMhz,
      replyFreqMhz: rxFreqMhz,
      pulseSpacingTxUs,
      pulseSpacingRxUs,
      transponderDelayUs
    };
  }

  /**
   * Helper: Encode Station Identifier into 1350 Hz Morse Code string
   */
  function encodeMorse(ident) {
    const clean = ident.toUpperCase().replace(/[^A-Z]/g, '');
    const morseArray = [];
    for (const char of clean) {
      if (MORSE_MAP[char]) {
        morseArray.push(MORSE_MAP[char]);
      }
    }
    return {
      ident: clean,
      morseString: morseArray.join(' '),
      audioToneHz: 1350
    };
  }

  /**
   * ARINC 709A Airborne Distance Measuring Equipment (DME) Class
   */
  class ARINC709Transponder {
    constructor(config = {}) {
      this.unitId = config.unitId || 1; // 1 = DME 1 (Captain), 2 = DME 2 (First Officer)
      this.vhfFrequency = config.vhfFrequency || 115.30; // e.g. DXB VOR/DME 115.30 MHz
      this.stationIdent = config.stationIdent || 'DXB';
      this.stationElevationFt = config.stationElevationFt || 62.0; // Dubai Int'l elevation
      this.aircraftAltitudeFt = config.aircraftAltitudeFt || 35000.0; // FL350
      this.groundDistanceNm = config.groundDistanceNm || 42.5; // True horizontal distance
      this.groundSpeedKt = config.groundSpeedKt || 450.0; // Knots
      this.mode = config.mode || DME_MODES.TRACK;
      this.scanningActive = true;
      this.memoryTimer = 0; // Seconds in memory hold

      // Multi-Channel Scanning DME Channels (5 Channels)
      this.scanChannels = [
        { channelId: 1, type: 'ONSIDE_DISPLAY', vhfFreq: 115.30, ident: 'DXB', slantRangeNm: 0, groundSpeedKt: 0, status: 'TRACK' },
        { channelId: 2, type: 'FMS_RNAV_AUTO1', vhfFreq: 113.60, ident: 'SHJ', slantRangeNm: 0, groundSpeedKt: 0, status: 'TRACK' },
        { channelId: 3, type: 'FMS_RNAV_AUTO2', vhfFreq: 117.10, ident: 'ALN', slantRangeNm: 0, groundSpeedKt: 0, status: 'TRACK' },
        { channelId: 4, type: 'FMS_RNAV_AUTO3', vhfFreq: 114.90, ident: 'FUJ', slantRangeNm: 0, groundSpeedKt: 0, status: 'TRACK' },
        { channelId: 5, type: 'FMS_RNAV_AUTO4', vhfFreq: 112.40, ident: 'RAK', slantRangeNm: 0, groundSpeedKt: 0, status: 'TRACK' }
      ];

      this.updateCalculations();
    }

    setVhfFrequency(freqMhz) {
      this.vhfFrequency = Math.max(108.0, Math.min(117.95, parseFloat(freqMhz)));
      this.scanChannels[0].vhfFreq = this.vhfFrequency;
      this.updateCalculations();
      return this.vhfFrequency;
    }

    setDistance(groundNm, altFt = null) {
      this.groundDistanceNm = Math.max(0.0, Math.min(350.0, parseFloat(groundNm)));
      if (altFt !== null) {
        this.aircraftAltitudeFt = Math.max(0, Math.min(50000, parseFloat(altFt)));
      }
      this.updateCalculations();
      return this.slantRangeNm;
    }

    setMode(mode) {
      if (!Object.values(DME_MODES).includes(mode)) {
        throw new Error(`Invalid DME Mode: ${mode}`);
      }
      this.mode = mode;
      return this.mode;
    }

    updateCalculations() {
      // 1. Slant range geometry: Slant^2 = Ground^2 + Height^2
      // Height in NM: (Altitude - StationElevation) / 6076.12 ft/NM
      const deltaAltFt = Math.max(0, this.aircraftAltitudeFt - this.stationElevationFt);
      const deltaAltNm = deltaAltFt / 6076.12;
      this.slantRangeNm = parseFloat(Math.sqrt(Math.pow(this.groundDistanceNm, 2) + Math.pow(deltaAltNm, 2)).toFixed(2));

      // 2. Round-trip pulse propagation time (microseconds)
      // T_RTT = T_transponder_delay + (12.3592 us/NM * SlantRangeNm)
      const chInfo = pairVhfToDmeChannel(this.vhfFrequency);
      this.channelInfo = chInfo;
      this.roundTripTimeUs = parseFloat((chInfo.transponderDelayUs + (RADAR_MILE_US_PER_NM * this.slantRangeNm)).toFixed(3));

      // 3. Time-to-Station (Minutes)
      if (this.groundSpeedKt > 10) {
        this.timeToStationMin = parseFloat(((this.slantRangeNm / this.groundSpeedKt) * 60.0).toFixed(1));
      } else {
        this.timeToStationMin = 999.0;
      }

      // 4. Update multi-channel scanning targets
      this.scanChannels[0].slantRangeNm = this.slantRangeNm;
      this.scanChannels[0].groundSpeedKt = this.groundSpeedKt;
      this.scanChannels[1].slantRangeNm = parseFloat((this.slantRangeNm * 1.15).toFixed(2));
      this.scanChannels[2].slantRangeNm = parseFloat((this.slantRangeNm * 1.32).toFixed(2));
      this.scanChannels[3].slantRangeNm = parseFloat((this.slantRangeNm * 1.48).toFixed(2));
      this.scanChannels[4].slantRangeNm = parseFloat((this.slantRangeNm * 1.65).toFixed(2));

      // 5. Morse Code Station Ident
      this.morseIdent = encodeMorse(this.stationIdent);
    }

    /**
     * Encode ARINC 429 Label 035 (DME Tuning Word)
     * Format: BCD frequency representation
     */
    encodeLabel035() {
      // Frequency: e.g. 115.30 -> Hundreds=1, Tens=1, Units=5, Tenths=3, Hundredths=0
      const freqInt = Math.round(this.vhfFrequency * 100);
      const d100 = Math.floor(freqInt / 10000) % 10;
      const d10 = Math.floor(freqInt / 1000) % 10;
      const d1 = Math.floor(freqInt / 100) % 10;
      const d01 = Math.floor(freqInt / 10) % 10;
      const d001 = freqInt % 10;

      // Pack into 16-bit BCD
      const bcdVal = (d10 << 12) | (d1 << 8) | (d01 << 4) | (d001);
      const sdi = (this.unitId === 2) ? 2 : 1;
      const ssm = 0x03; // Normal Operation
      return encodeARINC429Word(ARINC429_LABELS.DME_TUNING, sdi, bcdVal, ssm);
    }

    /**
     * Encode ARINC 429 Label 201 (DME Distance / Slant Range)
     * Format: BNR binary word, range 0 to 384+ NM, resolution 0.125 NM
     */
    encodeLabel201() {
      // Scale: 0.125 NM per LSB (1/8 NM)
      const bnrUnits = Math.min(0x7FFFF, Math.round(this.slantRangeNm / 0.125));
      const sdi = (this.unitId === 2) ? 2 : 1;
      const ssm = (this.mode === DME_MODES.SEARCH) ? 0x01 : 0x03; // 01=NCD while searching, 03=Normal
      return encodeARINC429Word(ARINC429_LABELS.DME_DISTANCE, sdi, bnrUnits, ssm);
    }

    /**
     * Encode ARINC 429 Label 202 (DME Groundspeed / Time-to-Station)
     */
    encodeLabel202() {
      // Scale: 1 kt per LSB for speed (Bits 11-20), 0.1 min for time (Bits 21-28)
      const speedBits = Math.min(0x3FF, Math.round(this.groundSpeedKt)) & 0x3FF;
      const timeBits = Math.min(0xFF, Math.round(this.timeToStationMin * 2)) & 0xFF;
      const dataField = (timeBits << 10) | speedBits;
      const sdi = (this.unitId === 2) ? 2 : 1;
      const ssm = 0x03; // Normal Operation
      return encodeARINC429Word(ARINC429_LABELS.DME_TIME_SPEED, sdi, dataField, ssm);
    }

    /**
     * Encode ARINC 429 Label 270 (DME Equipment Status Word)
     */
    encodeLabel270() {
      let statusBits = 0;
      if (this.mode === DME_MODES.TRACK) statusBits |= (1 << 0);
      if (this.mode === DME_MODES.SEARCH) statusBits |= (1 << 1);
      if (this.mode === DME_MODES.MEMORY) statusBits |= (1 << 2);
      if (this.scanningActive) statusBits |= (1 << 3); // Multi-channel scan active
      if (this.channelInfo.suffix === 'Y') statusBits |= (1 << 4); // Y-channel flag

      const sdi = (this.unitId === 2) ? 2 : 1;
      const ssm = 0x03; // Normal Operation
      return encodeARINC429Word(ARINC429_LABELS.DME_STATUS, sdi, statusBits, ssm);
    }

    /**
     * Encode ARINC 429 Label 350 (DME Maintenance & Fault Word)
     */
    encodeLabel350() {
      const faultBits = 0x00; // Normal healthy hardware
      const sdi = (this.unitId === 2) ? 2 : 1;
      const ssm = 0x03; // Normal Operation
      return encodeARINC429Word(ARINC429_LABELS.DME_FAULT, sdi, faultBits, ssm);
    }

    getTelemetrySnapshot() {
      const l035 = this.encodeLabel035();
      const l201 = this.encodeLabel201();
      const l202 = this.encodeLabel202();
      const l270 = this.encodeLabel270();
      const l350 = this.encodeLabel350();

      return {
        timestamp: new Date().toISOString(),
        unitId: `DME ${this.unitId} (${this.unitId === 1 ? 'Captain' : 'First Officer'})`,
        stationIdent: this.stationIdent,
        morseString: this.morseIdent.morseString,
        vhfFrequencyMhz: this.vhfFrequency,
        dmeChannel: this.channelInfo.channel,
        interrogationFreqMhz: this.channelInfo.interrogationFreqMhz,
        replyFreqMhz: this.channelInfo.replyFreqMhz,
        pulseSpacingTxUs: this.channelInfo.pulseSpacingTxUs,
        pulseSpacingRxUs: this.channelInfo.pulseSpacingRxUs,
        transponderDelayUs: this.channelInfo.transponderDelayUs,
        groundDistanceNm: this.groundDistanceNm,
        aircraftAltitudeFt: this.aircraftAltitudeFt,
        slantRangeNm: this.slantRangeNm,
        roundTripTimeUs: this.roundTripTimeUs,
        groundSpeedKt: this.groundSpeedKt,
        timeToStationMin: this.timeToStationMin,
        operationalMode: this.mode,
        multiChannelScanning: this.scanningActive,
        scanChannels: this.scanChannels,
        arinc429Words: {
          label035_Tuning: decodeARINC429Word(l035),
          label201_Distance: decodeARINC429Word(l201),
          label202_TimeSpeed: decodeARINC429Word(l202),
          label270_Status: decodeARINC429Word(l270),
          label350_Maintenance: decodeARINC429Word(l350)
        }
      };
    }
  }

  return {
    ARINC709Transponder,
    ARINC429_LABELS,
    DME_MODES,
    RADAR_MILE_US_PER_NM,
    calculateParity,
    reverseLabelBits,
    encodeARINC429Word,
    decodeARINC429Word,
    pairVhfToDmeChannel,
    encodeMorse
  };
}));
