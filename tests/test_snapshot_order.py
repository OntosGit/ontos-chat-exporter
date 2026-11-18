"""Synthetic public-import regressions for source chronology and preserved history."""
import io
import json
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import ontos_memory as memory

MISSING = object()
CID = '00000000-0000-4000-8000-000000000099'


class SnapshotOrder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = self.root / 'private.sqlite3'
        self.conn = memory.connect(self.db)
        self.sequence = 0

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def document(self, marker, updated=MISSING, cid=CID):
        result = {
            'id': cid, 'title': marker,
            'messages': [{'id': 'message-1', 'author': {'role': 'user'},
                          'content': {'content_type': 'text',
                                      'parts': ['Давай построим архитектуру ' + marker]}}],
        }
        if updated is not MISSING:
            result['update_time'] = updated
        return result

    def source(self, body, suffix='.json'):
        self.sequence += 1
        path = self.root / ('source-' + str(self.sequence) + suffix)
        text = json.dumps(body, ensure_ascii=False)
        if suffix == '.zip':
            with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('conversations.json', text)
        else:
            path.write_text(text, encoding='utf8')
        return path

    def ingest(self, marker, updated=MISSING, cid=CID):
        return memory.import_file(self.conn, self.source(self.document(marker, updated, cid)))

    def current(self, cid=CID):
        return dict(self.conn.execute('SELECT * FROM conversations WHERE id=?', (cid,)).fetchone())

    def test_dated_snapshot_survives_undated_json(self):
        self.ingest('Современная', 2000000000)
        before = self.current()
        candidate = memory.discover(self.conn, 10)[0]
        memory.record_architecture(self.conn, 'ARCH-ORDER', 'Память', 'researching',
                                   candidate['candidate_id'], '')
        evidence = memory.architecture_details(self.conn, 'ARCH-ORDER')
        result = self.ingest('Историческая')
        self.assertEqual(self.current(), before)
        self.assertEqual(len(memory.search(self.conn, 'Современная', 10)), 1)
        self.assertEqual(memory.search(self.conn, 'Историческая', 10), [])
        self.assertEqual(memory.discover(self.conn, 10)[0]['candidate_id'], candidate['candidate_id'])
        self.assertEqual(memory.architecture_details(self.conn, 'ARCH-ORDER'), evidence)
        self.assertEqual(memory.summary(self.conn)['snapshots'], 2)
        self.assertEqual(memory.summary(self.conn)['revisions'], 2)
        self.assertEqual(result['snapshot_selection'][0]['decision'], 'retained_unordered')

    def test_dated_snapshot_survives_undated_zip(self):
        path = self.source([self.document('Современная', 2000000000),
                            self.document('Историческая')], '.zip')
        result = memory.import_file(self.conn, path)
        self.assertEqual(self.current()['title'], 'Современная')
        self.assertEqual(self.current()['source_updated_at'], 2000000000)
        self.assertEqual(memory.summary(self.conn)['snapshots'], 2)
        self.assertEqual([x['decision'] for x in result['snapshot_selection']],
                         ['selected_initial', 'retained_unordered'])

    def test_boolean_date_does_not_advance_epoch_zero(self):
        self.ingest('Современная', 0)
        before = self.current()
        result = self.ingest('Подмена', True)
        self.assertEqual(self.current(), before)
        self.assertEqual(result['snapshot_selection'][0]['timestamp_status'], 'invalid')

    def test_invalid_dates_preserve_known_snapshot(self):
        for index, value in enumerate((False, '', 'unknown', 'NaN', 'Infinity',
                                       '-Infinity', float('nan'), float('inf'),
                                       float('-inf'), {}, [], 10 ** 400,
                                       1e300, -1e300, '1e300')):
            with self.subTest(value=repr(value)[:60]):
                cid = 'invalid-date-' + str(index)
                self.ingest('Современная', 0, cid)
                before = self.current(cid)
                result = self.ingest('Подмена', value, cid)
                self.assertEqual(self.current(cid), before)
                self.assertEqual(result['snapshot_selection'][0]['timestamp_status'], 'invalid')
                self.assertEqual(result['snapshot_selection'][0]['decision'], 'retained_unordered')
                json.dumps(result, allow_nan=False)

    def test_unknown_order_preserves_first_and_records_both(self):
        first = self.ingest('Первая')
        before = self.current()
        result = self.ingest('Вторая')
        self.assertEqual(self.current(), before)
        self.assertEqual(first['snapshot_selection'][0]['timestamp_status'], 'missing')
        self.assertEqual(result['snapshot_selection'][0]['decision'], 'retained_unordered')
        self.assertEqual(memory.summary(self.conn)['snapshots'], 2)

    def test_equal_time_different_content_is_not_ordered(self):
        self.ingest('Первая', 100)
        before = self.current()
        result = self.ingest('Вторая', 100)
        self.assertEqual(self.current(), before)
        self.assertEqual(result['snapshot_selection'][0]['decision'], 'retained_equal_time')
        self.assertEqual(memory.summary(self.conn)['snapshots'], 2)

    def test_first_known_date_takes_precedence_over_undated(self):
        self.ingest('Недатированная')
        result = self.ingest('Датированная', '0')
        self.assertEqual(self.current()['title'], 'Датированная')
        self.assertEqual(self.current()['source_updated_at'], 0)
        self.assertEqual(result['snapshot_selection'][0]['decision'], 'selected_dated')

    def test_strictly_newer_and_older_dates(self):
        self.ingest('Первая', 10)
        result = self.ingest('Новая', '10.5')
        self.assertEqual(self.current()['title'], 'Новая')
        self.assertEqual(result['snapshot_selection'][0]['decision'], 'selected_newer')
        before = self.current()
        old = self.ingest('Старая', 9)
        self.assertEqual(self.current(), before)
        self.assertEqual(old['snapshot_selection'][0]['decision'], 'retained_older')

    def test_same_fingerprint_cannot_erase_or_lower_known_time(self):
        self.ingest('Одинаковая', 100)
        before = self.current()
        self.ingest('Одинаковая')
        self.assertEqual(self.current(), before)
        result = self.ingest('Одинаковая', 99)
        self.assertEqual(self.current(), before)
        self.assertEqual(result['snapshot_selection'][0]['decision'], 'unchanged')
        self.assertEqual(memory.summary(self.conn)['snapshots'], 1)

    def test_same_fingerprint_can_raise_known_time(self):
        self.ingest('Одинаковая')
        sid = self.current()['current_snapshot']
        self.ingest('Одинаковая', 100)
        self.ingest('Одинаковая', 101)
        self.assertEqual(self.current()['current_snapshot'], sid)
        self.assertEqual(self.current()['source_updated_at'], 101)
        self.assertEqual(memory.summary(self.conn)['snapshots'], 1)

    def test_reimport_is_noop_and_reopen_preserves_decision(self):
        self.ingest('Современная', 2000000000)
        path = self.source(self.document('Историческая'))
        memory.import_file(self.conn, path)
        before = self.current()
        counts = memory.summary(self.conn)
        result = memory.import_file(self.conn, path)
        self.assertEqual(result['status'], 'already_imported')
        self.assertEqual(result['snapshot_selection'], [])
        self.assertEqual(memory.summary(self.conn), counts)
        self.conn.close()
        self.conn = memory.connect(self.db)
        self.assertEqual(self.current(), before)
        self.assertEqual(self.current()['title'], 'Современная')

    def test_cli_reports_unknown_as_valid_json(self):
        path = self.source(self.document('Недатированная', float('inf')))
        output = io.StringIO()
        with redirect_stdout(output):
            status = memory.main(['--db', str(self.db), 'import', str(path)])
        self.assertEqual(status, 0)
        def reject_nonfinite(value):
            raise AssertionError('Non-finite JSON number: ' + value)
        report = json.loads(output.getvalue(), parse_constant=reject_nonfinite)
        self.assertEqual(report['snapshot_selection'][0]['timestamp_status'], 'invalid')
        self.assertEqual(self.current()['source_updated_at'], None)

    def test_later_invalid_conversation_rolls_back_selection(self):
        self.ingest('Первая', 10)
        before = self.current()
        counts = memory.summary(self.conn)
        broken = {'id': 'broken', 'mapping': {}, 'current_node': 'absent'}
        path = self.source([self.document('Новая', 11), broken], '.zip')
        with self.assertRaises(ValueError):
            memory.import_file(self.conn, path)
        self.assertEqual(self.current(), before)
        self.assertEqual(memory.summary(self.conn), counts)

    def test_legacy_invalid_time_does_not_freeze_future_known_input(self):
        for index, legacy in enumerate((float('inf'), 'invalid-old-metadata', 1e300)):
            with self.subTest(legacy=legacy):
                cid = 'legacy-' + str(index)
                self.ingest('Прежняя', 10, cid)
                with self.conn:
                    self.conn.execute('UPDATE conversations SET source_updated_at=? WHERE id=?',
                                      (legacy, cid))
                result = self.ingest('Датированная', 11, cid)
                self.assertEqual(self.current(cid)['title'], 'Датированная')
                self.assertEqual(self.current(cid)['source_updated_at'], 11)
                self.assertEqual(result['snapshot_selection'][0]['decision'], 'selected_dated')

    def test_zip_member_order_cannot_override_source_time(self):
        path = self.root / 'members.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('conversations-000.json', json.dumps([self.document('Новая', 100)]))
            archive.writestr('conversations-001.json', json.dumps([self.document('Старая', 99),
                                                                  self.document('Неизвестная')]))
        memory.import_file(self.conn, path)
        self.assertEqual(self.current()['title'], 'Новая')
        self.assertEqual(memory.summary(self.conn)['snapshots'], 3)


if __name__ == '__main__':
    unittest.main()
