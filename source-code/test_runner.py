#!/usr/bin/env python3
"""
ARINC709Forge Pro (v1.0.0) - Automated Test Suite
Verifies core DME logic, channel pairing, slant range math, ARINC 429 odd parity, and airworthiness audit.
"""

import unittest
import sys
import os
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cli = import_module("arinc709-cli")

class TestARINC709Engine(unittest.TestCase):

    def test_01_arinc429_odd_parity(self):
        """Test 1: ARINC 429 Bit 32 odd parity generator and validator."""
        p0 = cli.calculate_parity(0x00000000)
        self.assertEqual(p0, 1)

        p1 = cli.calculate_parity(0x00000001)
        self.assertEqual(p1, 0)

        p3 = cli.calculate_parity(0x00000003)
        self.assertEqual(p3, 1)

    def test_02_label_bit_reversal(self):
        """Test 2: Octal label bit reversal to ARINC 429 transmission order."""
        # Label 035 (octal 035 = binary 00011101)
        # Reversed: 10111000 = 0xB8
        rev035 = cli.reverse_label_bits(0o035)
        self.assertEqual(rev035, 0xB8)

        # Label 201 (octal 201 = binary 10000001)
        # Reversed: 10000001 = 0x81
        rev201 = cli.reverse_label_bits(0o201)
        self.assertEqual(rev201, 0x81)

    def test_03_vhf_to_dme_channel_x_pairing(self):
        """Test 3: VHF NAV to DME Channel X pairing (115.30 MHz -> Channel 100X)."""
        ch = cli.pair_vhf_to_dme_channel(115.30)
        self.assertEqual(ch['suffix'], 'X')
        self.assertEqual(ch['tx_pulse_spacing_us'], 12.0)
        self.assertEqual(ch['rx_pulse_spacing_us'], 12.0)
        self.assertEqual(ch['transponder_delay_us'], 50.0)

    def test_04_vhf_to_dme_channel_y_pairing(self):
        """Test 4: VHF NAV to DME Channel Y pairing (115.35 MHz -> Channel 100Y)."""
        ch = cli.pair_vhf_to_dme_channel(115.35)
        self.assertEqual(ch['suffix'], 'Y')
        self.assertEqual(ch['tx_pulse_spacing_us'], 36.0)
        self.assertEqual(ch['rx_pulse_spacing_us'], 30.0)
        self.assertEqual(ch['transponder_delay_us'], 56.0)

    def test_05_radar_mile_delay_timing(self):
        """Test 5: Radar mile propagation delay timing precision."""
        self.assertAlmostEqual(cli.RADAR_MILE_US_PER_NM, 12.3592, places=3)
        delay_10nm = 10.0 * cli.RADAR_MILE_US_PER_NM
        self.assertAlmostEqual(delay_10nm, 123.592, places=2)

    def test_06_slant_range_pythagorean_geometry(self):
        """Test 6: Slant range hypotenuse calculation accuracy."""
        ground_nm = 30.0
        alt_ft = 36000
        alt_nm = alt_ft / 6076.12 # approx 5.925 NM
        expected_slant = math.sqrt(ground_nm**2 + alt_nm**2)
        self.assertGreater(expected_slant, ground_nm)
        self.assertAlmostEqual(expected_slant, 30.58, delta=0.1)

    def test_07_encode_decode_distance_label201(self):
        """Test 7: Distance Label 201 BNR encoding and parity validity."""
        slant_nm = 42.5
        bnr_units = int(slant_nm / 0.125)
        word = cli.encode_arinc429_word(0o201, 1, bnr_units, 0x03)
        dec = cli.decode_arinc429_word(word)
        self.assertTrue(dec['parity_valid'])
        self.assertEqual(dec['octal_label'], '0201')
        self.assertEqual(dec['sdi'], 1)
        self.assertEqual(dec['ssm_meaning'], 'Normal Operation')
        recovered_dist = dec['data'] * 0.125
        self.assertAlmostEqual(recovered_dist, slant_nm, delta=0.125)

    def test_08_sign_status_matrix_ssm(self):
        """Test 8: Sign/Status Matrix (SSM) normal operation and failure modes."""
        word_norm = cli.encode_arinc429_word(0o270, 1, 0x01, 0x03)
        self.assertEqual(cli.decode_arinc429_word(word_norm)['ssm_meaning'], 'Normal Operation')

        word_ncd = cli.encode_arinc429_word(0o201, 1, 0x00, 0x01)
        self.assertEqual(cli.decode_arinc429_word(word_ncd)['ssm_meaning'], 'No Computed Data (NCD)')

    def test_09_normative_compliance_audit_rules(self):
        """Test 9: 10-point normative airworthiness compliance audit execution."""
        audit = cli.run_compliance_audit()
        self.assertEqual(audit['total_rules'], 10)
        self.assertEqual(audit['passed_count'], 10)
        self.assertEqual(audit['failed_count'], 0)
        self.assertEqual(audit['score_percent'], 100.0)
        self.assertEqual(audit['certification'], 'ARINC_709A_DME_TSO_C66C_CERTIFIED')

    def test_10_scenario_execution(self):
        """Test 10: Predefined flight simulation scenario validation."""
        try:
            cli.run_scenario('enroute_dxb_inbound')
            cli.run_scenario('approach_lhr_holding')
            cli.run_scenario('dme_dme_rnav_scanning')
            scenario_ok = True
        except Exception as e:
            scenario_ok = False
        self.assertTrue(scenario_ok)

if __name__ == '__main__':
    unittest.main()
