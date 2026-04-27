"""
run.py — entry point for the SDATOS Flask web application.
Run with:  python run.py
"""
import sys
import os

# Ensure the project root is on the Python path so `src.*` imports resolve
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.interface.app import app

if __name__ == '__main__':
    app.run(debug=True, port=5000)
