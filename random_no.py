import csv
import os
import requests

API_KEY = "c2843cc4-9284-43bd-8448-9c76b42153b7"
CSV_FILE = "random_fetch.csv"


def obtain_random_number(num, min_val, max_val):
    url = "https://api.random.org/json-rpc/2/invoke"

    # Prepare the request data
    request_data = {
        "jsonrpc": "2.0",
        "method": "generateIntegers",
        "params": {
            "apiKey": API_KEY,
            "n": num,           # Number of random integers to generate
            "min": min_val,     # Minimum value (inclusive)
            "max": max_val,     # Maximum value (inclusive)
            "replacement": True # Allow duplicates
        },
        "id": 1
    }

    try:
        # Make the HTTP POST request
        response = requests.post(url, json=request_data)
        response_json = response.json()

        # Check if the response is successful
        if "result" in response_json and "random" in response_json["result"]:
            random_numbers = response_json["result"]["random"]["data"]
            return random_numbers
        else:
            print("Error:", response_json.get("error", "Unknown error"))
            return []
    except requests.exceptions.RequestException as e:
        print("Error making the request:", e)
        return []


def save_to_csv(numbers, csv_file):
    file_exists = os.path.isfile(csv_file)
    with open(csv_file, "a", newline="") as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow(["random_fetched"])
        for number in numbers:
            writer.writerow([number])


for i in range(1):
    num_random_numbers = 10000
    min_val = 1
    max_val = 10000000

    random_numbers = obtain_random_number(num_random_numbers, min_val, max_val)

    if random_numbers:
        save_to_csv(random_numbers, CSV_FILE)
