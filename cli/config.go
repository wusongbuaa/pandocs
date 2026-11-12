package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
)

// Config is what `pandocs login` remembers. PANDOCS_URL and PANDOCS_TOKEN win over it, for CI and agents.
type Config struct {
	Server string `json:"server"`
	Token  string `json:"token"`
}

func configPath() (string, error) {
	if path := os.Getenv("PANDOCS_CONFIG"); path != "" {
		return path, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "pandocs", "config.json"), nil
}

func loadConfig() (Config, error) {
	var config Config
	path, err := configPath()
	if err != nil {
		return config, err
	}
	raw, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return config, err
	}
	if err == nil {
		if err := json.Unmarshal(raw, &config); err != nil {
			return config, fmt.Errorf("%s is not readable: %w", path, err)
		}
	}
	if server := os.Getenv("PANDOCS_URL"); server != "" {
		config.Server = server
	}
	if token := os.Getenv("PANDOCS_TOKEN"); token != "" {
		config.Token = token
	}
	return config, nil
}

// saveConfig writes only what login was given, without the environment's overrides. The file holds a credential,
// so only its owner can read it. Windows ignores these modes, and there a user's profile is already private to them.
func saveConfig(config Config) (string, error) {
	path, err := configPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return "", err
	}
	if err := writeFileAtomic(path, raw, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func removeConfig() error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func validServer(server string) error {
	parsed, err := url.Parse(server)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("%q is not a server address: it should look like https://docs.example.com", server)
	}
	return nil
}

// plainTextOverNetwork says whether a token would cross a network in the clear.
func plainTextOverNetwork(server string) bool {
	parsed, err := url.Parse(server)
	if err != nil || parsed.Scheme != "http" {
		return false
	}
	host := parsed.Hostname()
	return host != "localhost" && host != "127.0.0.1" && host != "::1"
}
