package config

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func writeConfigAndVersion(t *testing.T, dir, configContent, version string) (configPath, versionPath string) {
	t.Helper()
	configPath = filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte(configContent), 0644); err != nil {
		t.Fatal(err)
	}
	versionPath = filepath.Join(dir, "VERSION")
	if err := os.WriteFile(versionPath, []byte(version), 0644); err != nil {
		t.Fatal(err)
	}
	return
}

func TestLoadReadsVersionFile(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "app:\n  name: MyApp\n", "1.2.3\n")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.App.Version != "1.2.3" {
		t.Errorf("App.Version = %q, want 1.2.3", cfg.App.Version)
	}
	if cfg.App.Name != "MyApp" {
		t.Errorf("App.Name = %q, want MyApp", cfg.App.Name)
	}
}

func TestLoadVersionMissingDefaultsToDev(t *testing.T) {
	dir := t.TempDir()
	configPath, _ := writeConfigAndVersion(t, dir, "", "")

	// Point the version path at a missing file.
	cfg, err := Load(configPath, filepath.Join(dir, "does-not-exist"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.App.Version != "dev" {
		t.Errorf("App.Version = %q, want dev", cfg.App.Version)
	}
}

func TestLoadEnvOverrides(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "", "2.0.0")

	t.Setenv("APP_NAME", "My App")
	t.Setenv("NOTES_DIR", "/tmp/basalt-notes")
	t.Setenv("PORT", "9000")
	t.Setenv("DEFAULT_THEME", "dark")
	t.Setenv("AUTOSAVE_DELAY_MS", "5000")
	t.Setenv("INDEX_FILE", "/tmp/basalt-index.gob")
	t.Setenv("AUTHENTICATION_ENABLED", "true")
	t.Setenv("AUTHENTICATION_PASSWORD", "env-password")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.App.Name != "My App" {
		t.Errorf("App.Name = %q, want My App", cfg.App.Name)
	}
	if cfg.Storage.NotesDir != "/tmp/basalt-notes" {
		t.Errorf("NotesDir = %q, want /tmp/basalt-notes", cfg.Storage.NotesDir)
	}
	if cfg.Server.Port != 9000 {
		t.Errorf("Port = %d, want 9000", cfg.Server.Port)
	}
	if cfg.UI.DefaultTheme != "dark" {
		t.Errorf("DefaultTheme = %q, want dark", cfg.UI.DefaultTheme)
	}
	if cfg.UI.AutosaveDelayMs != 5000 {
		t.Errorf("AutosaveDelayMs = %d, want 5000", cfg.UI.AutosaveDelayMs)
	}
	if cfg.Storage.IndexFile != "/tmp/basalt-index.gob" {
		t.Errorf("IndexFile = %q, want /tmp/basalt-index.gob", cfg.Storage.IndexFile)
	}
	if !cfg.Authentication.Enabled {
		t.Error("Authentication.Enabled = false, want true")
	}
	if cfg.Authentication.Password != "" {
		t.Error("Password was not cleared after hashing")
	}
	if cfg.Authentication.PasswordHash == "" {
		t.Error("PasswordHash is empty, want bcrypt hash")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(cfg.Authentication.PasswordHash), []byte("env-password")); err != nil {
		t.Errorf("PasswordHash does not match env password: %v", err)
	}
}

func TestLoadAutosaveClamp(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "", "1.0.0")

	setAutosave := func(t *testing.T, val string) int {
		t.Helper()
		t.Setenv("AUTOSAVE_DELAY_MS", val)
		cfg, err := Load(configPath, versionPath)
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		return cfg.UI.AutosaveDelayMs
	}

	if got := setAutosave(t, "100"); got != 250 {
		t.Errorf("AutosaveDelayMs = %d, want clamped 250", got)
	}
	if got := setAutosave(t, "90000"); got != 60000 {
		t.Errorf("AutosaveDelayMs = %d, want clamped 60000", got)
	}
	if got := setAutosave(t, "5000"); got != 5000 {
		t.Errorf("AutosaveDelayMs = %d, want 5000", got)
	}
	// Non-numeric env falls back to the config/default value.
	t.Setenv("AUTOSAVE_DELAY_MS", "not-a-number")
	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.UI.AutosaveDelayMs != 1000 {
		t.Errorf("AutosaveDelayMs = %d, want default 1000", cfg.UI.AutosaveDelayMs)
	}
}

func TestLoadDefaultIndexPath(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "", "1.0.0")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := filepath.Join(dir, ".basalt-index.gob")
	if cfg.Storage.IndexFile != want {
		t.Errorf("IndexFile = %q, want %q", cfg.Storage.IndexFile, want)
	}
}

func TestLoadPasswordClearedAndBcryptHashed(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "authentication:\n  password: config-password\n", "1.0.0")

	t.Setenv("AUTHENTICATION_PASSWORD", "") // ensure env does not interfere

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Authentication.Password != "" {
		t.Error("plain Password was not cleared")
	}
	if cfg.Authentication.PasswordHash == "" {
		t.Fatal("PasswordHash is empty, want bcrypt hash")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(cfg.Authentication.PasswordHash), []byte("config-password")); err != nil {
		t.Errorf("PasswordHash does not match config password: %v", err)
	}
}

func TestLoadDefaultAppNameBasalt(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "", "1.0.0")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.App.Name != "Basalt" {
		t.Errorf("App.Name = %q, want Basalt", cfg.App.Name)
	}
}
