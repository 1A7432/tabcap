# typed: strict
# frozen_string_literal: true

# Homebrew formula TEMPLATE for tabcap. scripts/homebrew-formula.ts fills the VERSION
# and the three SHA256_* placeholders from a release's SHA256SUMS; .github/workflows/homebrew.yml
# does that for every published GitHub release and pushes Formula/tabcap.rb to the tap
# https://github.com/1A7432/homebrew-tabcap (`brew install 1A7432/tabcap/tabcap`).
# Built targets: macOS arm64, Linux x64 and arm64 (no Intel macOS build).
class Tabcap < Formula
  desc "Browser for AI agents: background tabs, a11y-tree refs, recorded traffic"
  homepage "https://github.com/1A7432/tabcap"
  version "{{VERSION}}"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "https://github.com/1A7432/tabcap/releases/download/v{{VERSION}}/tabcap-v{{VERSION}}-darwin-arm64.tar.gz"
      sha256 "{{SHA256_DARWIN_ARM64}}"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/1A7432/tabcap/releases/download/v{{VERSION}}/tabcap-v{{VERSION}}-linux-x64.tar.gz"
      sha256 "{{SHA256_LINUX_X64}}"
    end
    on_arm do
      url "https://github.com/1A7432/tabcap/releases/download/v{{VERSION}}/tabcap-v{{VERSION}}-linux-arm64.tar.gz"
      sha256 "{{SHA256_LINUX_ARM64}}"
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
