package main

import (
	"os/exec"
	"regexp"
)

// The protected tree. It must equal ROOTS.darwin in ../broker-paths.mjs: the
// Node broker compares its socket and origin paths by exact string, and
// platform_test.go holds the two together.
const base = "/Library/muxpad-broker"

var aclEntry = regexp.MustCompile(`(?m)^\s*\d+:`)

// extendedGrants reports whether path carries any ACL entry. A tool that
// cannot answer is an error, never "none".
func extendedGrants(path string) (bool, error) {
	command := exec.Command("/bin/ls", "-lde", path)
	command.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL=C"}
	acl, err := command.Output()
	if err != nil {
		return false, err
	}
	return aclEntry.Match(acl), nil
}
