import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'setup/preview'))
from media_contract import (  # noqa: E402
    MediaContractError,
    MediaTracker,
    dimensions_from_caps,
    fit_square_pixel_size,
    unknown_media,
    validate_media,
)


class Structure:
    def __init__(self, width, height):
        self.values = {'width': width, 'height': height}

    def get_value(self, key):
        return self.values[key]


class Caps:
    def __init__(self, width, height):
        self.structure = Structure(width, height)

    def get_size(self):
        return 1

    def get_structure(self, _):
        return self.structure


class MediaContractTests(unittest.TestCase):
    def test_encoder_size_preserves_aspect_and_uses_even_bounds(self):
        self.assertEqual(fit_square_pixel_size((1920, 1080), (1280, 1080)), (1280, 720))
        self.assertEqual(fit_square_pixel_size((1920, 1080), (1920, 1080)), (1920, 1080))
        self.assertEqual(fit_square_pixel_size((800, 600), (1920, 1080)), (800, 600))
        self.assertEqual(fit_square_pixel_size((1080, 1920), (1920, 1080)), (606, 1080))
        with self.assertRaises(MediaContractError):
            fit_square_pixel_size((True, 1080), (1920, 1080))

    def test_unknown_fixture_does_not_invent_dimensions(self):
        media = unknown_media()
        self.assertEqual(media['geometry'], {'state': 'unknown', 'reason': 'geometry_not_observed'})
        self.assertIsNone(dimensions_from_caps(None))
        self.assertIsNone(dimensions_from_caps({'width': 1920, 'height': (2, 1080)}))

    def test_current_caps_accept_odd_real_dimensions(self):
        self.assertEqual(dimensions_from_caps(Caps(1279, 719)), (1279, 719))
        tracker = MediaTracker('portal', source_state='unavailable', source_reason='not_started')
        tracker.begin_source('source-fixture')
        tracker.update_capture((1279, 719))
        tracker.update_encoded((1279, 719))
        tracker.set_codecs(['H264'], selected='H264')
        media = tracker.snapshot()
        self.assertEqual(media['geometry']['epoch'], 1)
        self.assertEqual((media['geometry']['width'], media['geometry']['height']), (1279, 719))
        tracker.clear_encoded()
        media = tracker.snapshot()
        self.assertEqual(media['geometry']['state'], 'unknown')
        self.assertNotIn('selectedCodec', media['video'])

    def test_epoch_changes_only_when_observed_geometry_changes(self):
        tracker = MediaTracker('portal')
        tracker.begin_source('source-fixture')
        tracker.update_geometry(capture=(1920, 1080), encoded=(1919, 1079))
        self.assertEqual(tracker.snapshot()['geometry']['epoch'], 1)
        tracker.update_geometry(capture=(1920, 1080), encoded=(1919, 1079))
        self.assertEqual(tracker.snapshot()['geometry']['epoch'], 1)
        tracker.update_capture(None)
        self.assertEqual(tracker.snapshot()['geometry'], {'state': 'unknown', 'reason': 'geometry_not_observed'})
        tracker.update_capture((1280, 720))
        self.assertEqual(tracker.snapshot()['geometry']['epoch'], 2)
        tracker.update_capture(None)
        self.assertEqual(tracker.snapshot()['geometry'], {'state': 'unknown', 'reason': 'geometry_not_observed'})
        tracker.set_source_unavailable('portal_restart')
        self.assertEqual(tracker.snapshot()['geometry']['state'], 'unavailable')
        tracker.begin_source('source-new')
        tracker.update_capture((1280, 720))
        tracker.update_encoded((1280, 720))
        self.assertEqual(tracker.snapshot()['geometry']['epoch'], 1)

    def test_contract_rejects_false_or_private_metadata(self):
        media = unknown_media()
        media['source'] = {'state': 'available', 'id': 'opaque-fixture', 'kind': 'portal', 'node': 42}
        with self.assertRaises(MediaContractError):
            validate_media(media)

        boolean_version = unknown_media()
        boolean_version['version'] = True
        with self.assertRaises(MediaContractError):
            validate_media(boolean_version)

        float_version = unknown_media()
        float_version['version'] = 1.0
        with self.assertRaises(MediaContractError):
            validate_media(float_version)
        media = {
            'version': 1,
            'source': {'state': 'available', 'id': 'opaque-fixture', 'kind': 'portal'},
            'geometry': {'state': 'available', 'epoch': 1, 'width': 1920, 'height': 1080},
            'video': {'state': 'unknown', 'reason': 'codec_not_probed'},
        }
        with self.assertRaises(MediaContractError):
            validate_media(media)
        media = unknown_media()
        media['geometry'] = {'state': 'available', 'epoch': 1, 'width': 1920, 'height': 1080, 'node': 42}
        with self.assertRaises(MediaContractError):
            validate_media(media)

    def test_selected_codec_requires_runtime_advertisement(self):
        tracker = MediaTracker('hfr-worker')
        tracker.begin_source('worker-source')
        tracker.set_codecs(['H264'])
        with self.assertRaises(MediaContractError):
            tracker.select_codec('H265')
        tracker.select_codec('H264')
        self.assertEqual(tracker.snapshot()['video']['selectedCodec'], 'H264')


if __name__ == '__main__':
    unittest.main()
