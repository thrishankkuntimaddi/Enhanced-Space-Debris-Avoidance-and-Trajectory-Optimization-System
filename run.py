"""Local entry point:  python run.py  ->  http://127.0.0.1:5000"""
from src.interface.app import app

if __name__ == "__main__":
    app.run(debug=False, port=5000)
