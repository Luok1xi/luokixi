from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from university_sources_robot import apply_file_metadata
from source_classification import link_suites


class FileMetadataTests(unittest.TestCase):
    def resource(self, school, kind):
        return dict(id=school+'-'+kind,schoolId=school,sourceId=school+'-source',course='数据结构',kind=kind,confidence={},classificationEvidence=[],relatedResourceIds=[])

    def test_registered_academic_year_and_paper_pair(self):
        sample=dict(year='2017-2018',term='1',bundleKey='same-paper')
        paper=apply_file_metadata(self.resource('hdu','exam'),sample)
        answer=apply_file_metadata(self.resource('hdu','answer'),sample)
        link_suites([paper,answer])
        self.assertEqual(paper['year'],2017)
        self.assertEqual(paper['academicYear'],'2017-2018')
        self.assertEqual(paper['term'],'第一学期')
        self.assertEqual(paper['relatedResourceIds'],[answer['id']])

    def test_identical_registered_pair_name_does_not_merge_schools(self):
        sample=dict(year='2017-2018',term='1',bundleKey='same-paper')
        paper=apply_file_metadata(self.resource('hdu','exam'),sample)
        answer=apply_file_metadata(self.resource('bupt','answer'),sample)
        link_suites([paper,answer])
        self.assertNotEqual(paper['suiteKey'],answer['suiteKey'])
        self.assertEqual(paper['relatedResourceIds'],[])


if __name__=='__main__':unittest.main()
