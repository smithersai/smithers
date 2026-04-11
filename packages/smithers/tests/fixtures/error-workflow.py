"""Exits with code 1 and an error message on stderr."""
import sys

sys.stderr.write("Something went wrong in the Python workflow\n")
sys.exit(1)
