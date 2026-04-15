// Single integration test binary to avoid 9x link overhead on CI.
// Individual test modules live in tests/suite/*.rs.
mod suite {
    mod test_agent;
    mod test_base64;
    mod test_config;
    mod test_db;
    mod test_diff;
    mod test_mcp;
    mod test_model;
    mod test_names;
    mod test_permissions;
}
