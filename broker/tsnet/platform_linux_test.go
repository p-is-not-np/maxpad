package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeTools(t *testing.T, getfacl, getcap string) {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{"getfacl": getfacl, "getcap": getcap} {
		if body == "" {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	saved := toolDirs
	toolDirs = []string{dir}
	t.Cleanup(func() { toolDirs = saved })
}

func TestExtendedGrantsLinux(t *testing.T) {
	for _, c := range []struct {
		name, getfacl, getcap string
		granted, fails        bool
	}{
		{name: "base entries only", getfacl: "exit 0", getcap: "exit 0"},
		{name: "named user entry", getfacl: "echo 'user:agent:r--'", getcap: "exit 0", granted: true},
		{name: "default ACL", getfacl: "echo 'default:user::rwx'", getcap: "exit 0", granted: true},
		{name: "file capability", getfacl: "exit 0", getcap: "echo \"$2 cap_net_admin=ep\"", granted: true},
		{name: "getfacl fails", getfacl: "exit 1", getcap: "exit 0", fails: true},
		{name: "getcap fails", getfacl: "exit 0", getcap: "exit 1", fails: true},
		{name: "getfacl missing", getcap: "exit 0", fails: true},
		{name: "getcap missing", getfacl: "exit 0", fails: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			fakeTools(t, c.getfacl, c.getcap)
			granted, err := extendedGrants("/opt/muxpad-broker")
			if (err != nil) != c.fails || granted != c.granted {
				t.Fatalf("granted=%v err=%v", granted, err)
			}
		})
	}
}

// The ACL tools are an INSTALL prerequisite (acl, libcap2-bin), not a build
// one. Where they are absent, the socket tests would stop at the inspection
// before reaching what they test, so "no grants" is stubbed for them — said
// out loud, and TestExtendedGrantsLinux still covers the inspection itself.
func TestMain(m *testing.M) {
	if _, err := inspect("getfacl", "--version"); err != nil {
		dir, _ := os.MkdirTemp("", "acl-stub-")
		for _, name := range []string{"getfacl", "getcap"} {
			os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\nexit 0\n"), 0o755)
		}
		toolDirs = []string{dir}
		fmt.Fprintln(os.Stderr, "acl tools absent: ACL inspection stubbed for socket tests ("+strings.TrimSpace(err.Error())+")")
		code := m.Run()
		os.RemoveAll(dir)
		os.Exit(code)
	}
	os.Exit(m.Run())
}
