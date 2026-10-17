# typed: strict
# frozen_string_literal: true

# Homebrew formula for tabcap. The tap is https://github.com/1A7432/homebrew-tabcap
# (its Formula/tabcap.rb is this file); `brew install 1A7432/tabcap/tabcap`.
# Per release: set `version`, replace the version in the three URLs and copy the
# three sha256 from the release's SHA256SUMS (release and SHA256SUMS are built by
# .github/workflows/release.yml); then commit the file to the tap.
# Built targets: macOS arm64, Linux x64 and arm64 (no Intel macOS build).
class Tabcap < Formula
  desc "Browser for AI agents: background tabs, a11y-tree refs, recorded traffic"
  homepage "https://github.com/1A7432/tabcap"
  version "0.7.2"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/1A7432/tabcap/releases/download/v0.7.2/tabcap-v0.7.2-darwin-arm64.tar.gz"
      sha256 "2c806dbef90ee94352927374a2964f465426e76c15177e746210c79395e0facf"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/1A7432/tabcap/releases/download/v0.7.2/tabcap-v0.7.2-linux-x64.tar.gz"
      sha256 "ecb321eacf5b8d605714791debb3ab5d27b782fa566c735caf0a7a78448795d6"
    end
    on_arm do
      url "https://github.com/1A7432/tabcap/releases/download/v0.7.2/tabcap-v0.7.2-linux-arm64.tar.gz"
      sha256 "abb0bafa64d4d2f9db1e2dc2974f1277155bffa163ba13289556c55e3993ab41"
    end
  end

  def install
    bin.install "tabcap"
    (pkgshare/"skills").install "skills/tabcap"
    (pkgshare/"templates").install Dir["templates/*"]
    doc.install "README.md", "README.zh-CN.md"
  end

  def caveats
    <<~EOS
      Run `tabcap setup` once to download Chrome for Testing.
      The agent skill is in #{opt_pkgshare}/skills/tabcap: copy it to
      ~/.claude/skills/tabcap (Claude Code) or your agent's skills directory.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tabcap --version")
  end
end
