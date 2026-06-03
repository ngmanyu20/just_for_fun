import math
import pandas as pd
import scipy.stats

CSV_FILE = 'E:\\Coding Site\\just_for_fun\\randomno.csv'


def clean_index():
    """Reset the CSV index pointer back to 0."""
    df = pd.read_csv(CSV_FILE, header=None)
    df.iloc[0, 0] = 0
    df.to_csv(CSV_FILE, index=False, header=False)


def return_ran():
    """Return a single random integer from the CSV (range: 1 to 10,000,000)."""
    df = pd.read_csv(CSV_FILE, header=None)
    index = int(df.iloc[0, 0])
    random_no = int(df.iloc[index + 2, 0])
    df.iloc[0, 0] = index + 1
    df.to_csv(CSV_FILE, index=False, header=False)
    return random_no


def return_ran_array(req_no):
    """Return a list of `req_no` random integers from the CSV."""
    df = pd.read_csv(CSV_FILE, header=None)
    index = int(df.iloc[0, 0])
    required_array = df.iloc[index + 2:index + req_no + 2, 0].tolist()
    required_array = [int(x) for x in required_array]
    df.iloc[0, 0] = index + req_no
    df.to_csv(CSV_FILE, index=False, header=False)
    return required_array


def random_normal(input_mean, input_sd):
    """
    Generate a single normally distributed random integer.

    Parameters
    ----------
    input_mean : float
        Mean of the distribution.
    input_sd : float
        Standard deviation. Pass math.sqrt(variance) if you have variance.
        Returns 0 if input_sd <= 0.

    Returns
    -------
    int
        Rounded sample from N(input_mean, input_sd²).
    """
    if input_sd <= 0:
        return 0
    uniform = (return_ran() - 1) / (10_000_000 - 1)
    return round(scipy.stats.norm.ppf(uniform, loc=input_mean, scale=input_sd))


def random_normal_from_variance(input_mean, input_variance):
    """
    Convenience wrapper: generate a single normal random integer using variance.

    Parameters
    ----------
    input_mean : float
    input_variance : float
        Variance (will be converted to std dev internally).
    """
    return random_normal(input_mean, math.sqrt(input_variance))


def random_normal_adv(input_mean, input_sd):
    """
    Generate a list of normally distributed random integers (vectorized).

    Entries where mean == 0 are skipped (returned as 0) without consuming
    a random number, keeping the draw count consistent.

    Parameters
    ----------
    input_mean : list[float]
        List of means, one per sample.
    input_sd : list[float]
        List of standard deviations, one per sample.

    Returns
    -------
    list[int]
        Rounded samples aligned to input_mean / input_sd.
    """
    non_zero_count = sum(1 for m in input_mean if m != 0)
    random_array = return_ran_array(non_zero_count)
    uniforms = iter((x - 1) / (10_000_000 - 1) for x in random_array)

    result = []
    for mean, sd in zip(input_mean, input_sd):
        if mean == 0:
            result.append(0)
        else:
            u = next(uniforms)
            result.append(round(scipy.stats.norm.ppf(u, loc=mean, scale=sd)))
    return result


def random_normal_adv_from_variance(input_mean, input_variance):
    """
    Convenience wrapper: vectorized normal random integers using variance lists.

    Parameters
    ----------
    input_mean : list[float]
    input_variance : list[float]
    """
    input_sd = [math.sqrt(v) for v in input_variance]
    return random_normal_adv(input_mean, input_sd)
