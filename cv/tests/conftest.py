import sys
from pathlib import Path

# Make `import hackcc_cv` work when running pytest from the cv/ folder.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
