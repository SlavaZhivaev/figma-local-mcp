import unittest
import upstream_tests as upstream
import legacy_tests as legacy

def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for cls in (legacy.Token, legacy.Comments, legacy.Updates, legacy.Protocol, legacy.SharedBridge, upstream.Extras):
        suite.addTests(loader.loadTestsFromTestCase(cls))
    for name in ('test_project_folder_uses_its_build', 'test_design_context_is_saved_with_assets', 'test_long_code_goes_to_a_file', 'test_project_pages_are_packed_with_a_router', 'test_annotations_prompts_and_instructions', 'test_code_layer_exports_as_website_folder', 'test_github_links_and_pack_pages'):
        suite.addTest(upstream.CodeLayers(name))
    return suite
